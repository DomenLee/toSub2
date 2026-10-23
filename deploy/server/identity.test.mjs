import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeAccount, workspaceOf } from "./identity.mjs";
import { createSync } from "./sync.mjs";

const token = (workspace, session) => "test." + Buffer.from(JSON.stringify({ sid: session, "https://api.openai.com/auth": { chatgpt_account_id: workspace } })).toString("base64url") + ".test";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-identity-"));
const source = { name: "test@example.invalid", platform: "openai", type: "oauth", credentials: { email: "test@example.invalid", chatgpt_account_id: "authsess_new", access_token: token("workspace-a", "authsess_new"), id_token: token("workspace-a", "authsess_new"), refresh_token: "FAKE_REFRESH" } };
const job = { id: "test-job", email: source.name, status: "completed", resultSaved: true, outputPath: path.join(root, "oauth.json") };
let account = { id: 212, name: source.name, platform: "openai", type: "oauth", status: "error", schedulable: false, error_message: "HTTP 401", group_ids: [7], credentials: { email: source.name, chatgpt_account_id: "authsess_old", model_mapping: { model: "keep" } } };
let clears = 0;
let applies = 0;
let creates = 0;
const request = async (endpoint, options = {}) => {
  if (endpoint.includes("?")) return { pages: 1, items: [account, { ...account, id: 215 }] };
  if (options.method === undefined) return account;
  if (endpoint.endsWith("/apply-oauth-credentials")) {
    applies++;
    assert.deepEqual(Object.keys(options.body), ["type", "credentials", "extra"]);
    account = { ...account, status: "active", error_message: "", credentials: { ...account.credentials, ...options.body.credentials } };
  } else if (endpoint.endsWith("/clear-error")) {
    clears++;
    if (clears === 1) throw new Error("Fake partial cleanup failure");
  } else if (endpoint.endsWith("/schedulable")) {
    account.schedulable = options.body.schedulable;
  } else { creates++; }
  return account;
};
try {
  assert.equal(normalizeAccount(source).credentials.chatgpt_account_id, "workspace-a");
  assert.equal(source.credentials.chatgpt_account_id, "authsess_new");
  assert.equal(workspaceOf(account), "");
  assert.throws(() => normalizeAccount(account), /真实工作区/);
  assert.throws(() => normalizeAccount({ ...source, credentials: { ...source.credentials, id_token: token("workspace-b", "other") } }), /不一致/);
  const stateFile = path.join(root, "state.json");
  await fs.writeFile(stateFile, JSON.stringify({ [job.id]: { status: "synced", accountID: 212, workspaceID: "workspace-a", digest: "old" } }));
  await fs.writeFile(job.outputPath, JSON.stringify({ type: "sub2api-data", accounts: [source] }));
  const options = { jobs: new Map([[job.id, job]]), request, stateFile };
  const sync = await createSync(options);
  await sync.sync(job);
  assert.equal(sync.status()[0].status, "failed");
  assert.equal(sync.status()[0].accountID, 212);
  assert.equal(account.schedulable, false);
  const restored = await createSync(options);
  await restored.sync(job, true);
  assert.equal(restored.status()[0].status, "synced");
  assert.equal(restored.status()[0].accountID, 212);
  assert.equal(account.credentials.chatgpt_account_id, "workspace-a");
  assert.equal(account.credentials.model_mapping.model, "keep");
  assert.deepEqual(account.group_ids, [7]);
  assert.equal(account.schedulable, true);
  assert.equal(creates, 0);
  const previousApplies = applies;
  source.credentials.access_token = token("workspace-b", "authsess_other");
  source.credentials.id_token = token("workspace-b", "authsess_other");
  await fs.writeFile(job.outputPath, JSON.stringify({ type: "sub2api-data", accounts: [source] }));
  await restored.sync(job);
  assert.match(restored.status()[0].error, /不同工作区/);
  assert.equal(applies, previousApplies);
  assert.equal(creates, 0);
  const legacyState = path.join(root, "legacy.json");
  account.credentials.chatgpt_account_id = "authsess_unknown";
  delete account.credentials.access_token;
  delete account.credentials.id_token;
  const legacy = await createSync({ ...options, stateFile: legacyState });
  await legacy.sync(job);
  assert.match(legacy.status()[0].error, /对应关系/);
  assert.equal(creates, 0);
  const raw = await fs.readFile(job.outputPath, "utf8");
  const unchangedState = path.join(root, "unchanged.json");
  await fs.writeFile(unchangedState, JSON.stringify({ [job.id]: { status: "synced", accountID: 212, digest: crypto.createHash("sha256").update(raw).digest("hex") } }));
  const unchanged = await createSync({ ...options, stateFile: unchangedState });
  await unchanged.sync(job);
  assert.equal(applies, previousApplies);
  console.log("PASS: stable JWT identity, reject session IDs and workspace switches, preserve linked account, no duplicates, recover partial cleanup and scheduling, do not replay old tokens");
} finally { await fs.rm(root, { recursive: true, force: true }); }
