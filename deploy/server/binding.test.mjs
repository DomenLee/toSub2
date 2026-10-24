import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSync } from "./sync.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-binding-"));
const token = workspace => `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: workspace } })).toString("base64url")}.test`;
let counter = 0;

async function fixture({ sourceChanges = {}, accountChanges = {}, stateChanges = {}, mode = "ok" } = {}) {
  const directory = path.join(root, String(++counter));
  await fs.mkdir(directory);
  const email = "account@example.invalid";
  const source = { name: email, platform: "openai", type: "oauth", credentials: { email, access_token: token("workspace-a"), id_token: token("workspace-a"), refresh_token: "OLD_REFRESH", chatgpt_account_id: "authsess_old", ...sourceChanges }, extra: { chatgpt_account_id: "authsess_old", account_id: "authsess_old" } };
  const raw = JSON.stringify({ type: "sub2api-data", accounts: [source] });
  const digest = crypto.createHash("sha256").update(raw).digest("hex");
  const job = { id: "job", email, status: "completed", resultSaved: true, outputPath: path.join(directory, "oauth.json") };
  await fs.writeFile(job.outputPath, raw);
  const stateFile = path.join(directory, "state.json");
  await fs.writeFile(stateFile, JSON.stringify({ [job.id]: { email, status: "synced", accountID: 213, workspaceID: "workspace-a", digest, ...stateChanges } }));
  const account = { id: 213, name: email, platform: "openai", type: "oauth", status: "error", error_message: "HTTP 401", schedulable: false, group_ids: [7], proxy_id: 11, quota_limit: 100, quota_used: 12, credentials: { ...source.credentials, access_token: "CURRENT_ACCESS", id_token: "CURRENT_ID", refresh_token: "CURRENT_REFRESH", model_mapping: { model: "keep" } }, extra: { ...source.extra, quota_daily_limit: 20, custom: "keep" }, ...accountChanges };
  const original = structuredClone(account);
  const calls = [];
  let reads = 0;
  let clock = 100000;
  let behavior = mode;
  const request = async (endpoint, options = {}) => {
    calls.push({ endpoint, options });
    if (!options.method) {
      assert.equal(endpoint, "/api/v1/admin/accounts/213");
      reads++;
      if (behavior === "changed" && reads === 2) account.credentials.email = "other@example.invalid";
      if (behavior === "missing") throw Object.assign(new Error("HTTP 404"), { status: 404 });
      const redacted = structuredClone(account);
      for (const key of ["access_token", "id_token", "refresh_token"]) delete redacted.credentials[key];
      return redacted;
    }
    assert.equal(endpoint, "/api/v1/admin/accounts/bulk-update", "old artifacts must never apply tokens, clear errors, schedule, create or delete accounts");
    assert.equal(options.method, "POST");
    assert.deepEqual(options.body, { account_ids: [213], credentials: { chatgpt_account_id: "workspace-a" }, extra: { account_id: "workspace-a", chatgpt_account_id: "workspace-a" } });
    if (behavior === "reject") throw new Error("HTTP 503");
    if (behavior !== "no-write") {
      Object.assign(account.credentials, options.body.credentials);
      if (behavior !== "partial") Object.assign(account.extra, options.body.extra);
    }
    if (behavior === "timeout") throw new Error("timeout after write");
    return behavior === "bad-result" ? { success: 0, failed: 1, success_ids: [] } : { success: 1, failed: 0, success_ids: [213] };
  };
  const options = { jobs: new Map([[job.id, job]]), request, stateFile, now: () => clock };
  return { job, digest, account, original, calls, stateFile, sync: await createSync(options), restore: () => createSync(options), setMode: value => { behavior = value; }, advance: () => { clock += 60001; } };
}

const writes = item => item.calls.filter(call => call.options.method);
const checkPreserved = item => assert.deepEqual(item.account, { ...item.original, credentials: { ...item.original.credentials, chatgpt_account_id: "workspace-a" }, extra: { ...item.original.extra, account_id: "workspace-a", chatgpt_account_id: "workspace-a" } });

try {
  const legacy = await fixture();
  await legacy.sync.sync(legacy.job);
  assert.equal(legacy.sync.status()[0].status, "synced");
  assert.equal(legacy.sync.revision(legacy.job.id), legacy.digest);
  assert.equal(writes(legacy).length, 1);
  checkPreserved(legacy);
  assert.equal(JSON.stringify(legacy.sync.status()).includes("CURRENT_"), false);
  const count = legacy.calls.length;
  await legacy.sync.sync(legacy.job);
  const restarted = await legacy.restore();
  await restarted.sync(legacy.job);
  assert.equal(legacy.calls.length, count, "verification interval persists across restarts");
  legacy.advance();
  await restarted.sync(legacy.job);
  assert.equal(legacy.calls.length, count + 1, "unchanged digest still verifies the remote binding periodically");
  assert.equal(writes(legacy).length, 1, "normalized records need no writes");
  await restarted.sync(legacy.job, true);
  assert.equal(writes(legacy).length, 1, "manual retry cannot replay an already synced authorization");

  for (const mode of ["reject", "timeout", "partial", "no-write", "bad-result"]) {
    const retry = await fixture({ mode });
    await retry.sync.sync(retry.job);
    assert.equal(retry.sync.status()[0].status, "failed", mode);
    assert.equal(JSON.parse(await fs.readFile(retry.stateFile, "utf8"))[retry.job.id].syncedDigest, retry.digest);
    const failedCount = retry.calls.length;
    await retry.sync.sync(retry.job);
    assert.equal(retry.calls.length, failedCount, "failed checks respect backoff");
    retry.setMode("ok");
    const restored = await retry.restore();
    await restored.sync(retry.job, true);
    assert.equal(restored.status()[0].status, "synced", mode);
    assert.equal(writes(retry).length, ["timeout", "bad-result"].includes(mode) ? 1 : 2, mode);
    checkPreserved(retry);
  }

  for (const changes of [
    { stateChanges: { workspaceID: undefined } },
    { stateChanges: { accountID: undefined } },
    { stateChanges: { workspaceID: "workspace-b" } },
    { sourceChanges: { access_token: "opaque", id_token: "opaque", chatgpt_account_id: "workspace-a" } },
    { sourceChanges: { id_token: token("workspace-b") } },
    { sourceChanges: { access_token: token("authsess_old"), id_token: token("authsess_old") } },
    { accountChanges: { id: 214 } },
    { accountChanges: { type: "apikey" } },
    { accountChanges: { platform: "anthropic" } },
    { accountChanges: { parent_account_id: 99 } },
    { accountChanges: { credentials: { email: "other@example.invalid", chatgpt_account_id: "authsess_old" } } },
    { accountChanges: { credentials: { email: "account@example.invalid", chatgpt_account_id: "workspace-b" } } },
    { accountChanges: { extra: { chatgpt_account_id: "workspace-b" } } },
    { accountChanges: { credentials: { email: "account@example.invalid" }, extra: {} } },
    { mode: "changed" },
    { mode: "missing" },
  ]) {
    const blocked = await fixture(changes);
    await blocked.sync.sync(blocked.job);
    assert.equal(blocked.sync.status()[0].status, "failed", JSON.stringify(changes));
    const restored = await blocked.restore();
    await restored.sync(blocked.job, true);
    assert.equal(restored.status()[0].status, "failed");
    assert.equal(writes(blocked).length, 0, "untrusted bindings remain read-only even after a forced retry and restart");
  }

  const valid = await fixture({ sourceChanges: { access_token: "opaque", id_token: "opaque", chatgpt_account_id: "workspace-a" }, accountChanges: { credentials: { email: "account@example.invalid", chatgpt_account_id: "workspace-a" }, extra: {} }, stateChanges: { workspaceID: undefined } });
  await valid.sync.sync(valid.job);
  assert.equal(valid.sync.status()[0].status, "synced", "an already valid binding needs no historical token migration proof");
  assert.equal(writes(valid).length, 0);

  const deleting = await fixture({ stateChanges: { deleting: true } });
  await deleting.sync.sync(deleting.job, true);
  assert.equal(deleting.calls.length, 0);
  console.log("PASS: legacy metadata migration, redacted tokens, preserved credentials/configuration/401/scheduling, periodic verification, restart and timeout safety, identity guards, no old token replay");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
