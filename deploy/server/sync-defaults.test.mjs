import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSync } from "./sync.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-sync-defaults-"));
const token = workspace => `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: workspace } })).toString("base64url")}.test`;
const groups = [
  { id: 1, platform: "openai", status: "active", rate_multiplier: 1.8 },
  { id: 2, platform: "openai", status: "active", rate_multiplier: 0.01, is_exclusive: true },
  { id: 3, platform: "openai", status: "active", rate_multiplier: 1.79 },
  { id: 4, platform: "openai", status: "disabled", rate_multiplier: 3 },
  { id: 5, platform: "anthropic", status: "active", rate_multiplier: 3 },
  { id: 6, platform: "openai", status: "active", rate_multiplier: 3, auto_route_enabled: true },
  { id: 7, platform: "openai", status: "active", rate_multiplier: 3 },
  { id: 8, platform: "openai", status: "active", rate_multiplier: "invalid" },
];
async function scenario({ renamed = false, previous = true, remote = "old", workspace = "workspace-a", groupResponse = groups, stale = false } = {}) {
  const directory = await fs.mkdtemp(path.join(root, "case-"));
  const job = { id: crypto.randomUUID(), email: "new@example.invalid", emailRenamedFrom: renamed ? "old@example.invalid" : null, status: "completed", resultSaved: true, outputPath: path.join(directory, "oauth.json") };
  const source = { name: job.email, platform: "openai", type: "oauth", credentials: { email: stale ? "old@example.invalid" : job.email, access_token: token(workspace), refresh_token: "FAKE_REFRESH" }, priority: 99, concurrency: 99, group_ids: [999], proxy_key: "ignored", proxy_id: 999, proxy_group_id: 999, extra: { openai_first_serve: { proxy_mode: "all" }, openai_oauth_responses_websockets_v2_mode: "first_serve", openai_oauth_responses_websockets_v2_enabled: true, responses_websockets_v2_enabled: true, openai_ws_enabled: true, codex_fingerprint_mode: "off", custom: "keep" } };
  await fs.writeFile(job.outputPath, JSON.stringify({ type: "sub2api-data", accounts: [source] }));
  const stateFile = path.join(directory, "state.json");
  if (previous) await fs.writeFile(stateFile, JSON.stringify({ [job.id]: { email: job.email, accountID: 42, workspaceID: "workspace-a", digest: "old-digest", status: "failed" } }));
  const accounts = remote === "none" ? [] : [{ id: 42, name: remote === "old" ? "old@example.invalid" : job.email, platform: "openai", type: "oauth", credentials: { email: remote === "old" ? "old@example.invalid" : job.email, access_token: "KEEP_ACCESS", refresh_token: "KEEP_REFRESH", chatgpt_account_id: remote === "other-workspace" ? "workspace-other" : remote === "ambiguous" ? "" : "workspace-a" }, extra: { custom: "keep" }, group_ids: [999], priority: 5, concurrency: 3, proxy_id: 9 }];
  const before = structuredClone(accounts[0]);
  const calls = [];
  const request = async (endpoint, options = {}) => {
    calls.push({ endpoint, options });
    if (endpoint === "/api/v1/admin/groups/all?platform=openai") return groupResponse;
    if (endpoint.startsWith("/api/v1/admin/accounts?")) return { items: accounts, pages: 1 };
    if (endpoint === "/api/v1/admin/accounts" && options.method === "POST") { const account = { ...options.body, id: 77 }; accounts.push(account); return account; }
    const id = Number(endpoint.split("/")[5]);
    const account = accounts.find(item => item.id === id);
    if (!account) throw new Error("Missing account");
    if (endpoint.endsWith("/apply-oauth-credentials")) Object.assign(account.credentials, options.body.credentials);
    return account;
  };
  const jobs = new Map([[job.id, job]]);
  const sync = await createSync({ jobs, request, stateFile });
  await sync.sync(job, true);
  return { sync, job, accounts, before, calls, request, jobs, stateFile };
}
function assertDefaults(account) {
  assert.equal(account.priority, 1);
  assert.equal(account.concurrency, 10);
  assert.deepEqual(account.group_ids, [1, 2, 7]);
  assert.equal(account.proxy_id, null);
  assert.equal(account.proxy_group_id, null);
  assert.equal(account.proxy_key, undefined);
  assert.equal(account.extra.openai_first_serve, undefined);
  assert.equal(account.extra.openai_oauth_responses_websockets_v2_mode, "off");
  assert.equal(account.extra.openai_oauth_responses_websockets_v2_enabled, false);
  assert.equal(account.extra.responses_websockets_v2_enabled, false);
  assert.equal(account.extra.openai_ws_enabled, false);
  assert.equal(account.extra.codex_fingerprint_mode, "full");
  assert.equal(account.extra.custom, "keep");
  assert.equal(account.extra.chatgpt_account_id, "workspace-a");
}
try {
  const renamed = await scenario({ renamed: true });
  assert.equal(renamed.sync.status()[0].status, "synced");
  assert.equal(renamed.sync.status()[0].accountID, 77);
  assertDefaults(renamed.accounts[1]);
  assert.deepEqual(renamed.accounts[0], renamed.before);
  const fresh = await scenario({ previous: false, remote: "none" });
  assert.equal(fresh.sync.status()[0].status, "synced");
  assertDefaults(fresh.accounts[0]);
  const restored = await createSync({ jobs: renamed.jobs, request: renamed.request, stateFile: renamed.stateFile });
  await restored.sync(renamed.job, true);
  assert.equal(restored.status()[0].accountID, 77);
  assert.equal(renamed.calls.filter(call => call.endpoint === "/api/v1/admin/accounts").length, 1);
  const existing = await scenario({ renamed: true, remote: "new" });
  assert.equal(existing.sync.status()[0].status, "synced");
  assert.equal(existing.accounts.length, 1);
  for (const key of ["priority", "concurrency", "group_ids", "proxy_id", "extra"]) assert.deepEqual(existing.accounts[0][key], existing.before[key]);
  assert.equal(existing.calls.some(call => call.endpoint.includes("groups/all")), false);
  for (const options of [
    {},
    { renamed: true, workspace: "workspace-other" },
    { renamed: true, remote: "ambiguous" },
    { renamed: true, remote: "other-workspace" },
    { renamed: true, stale: true },
    { renamed: true, groupResponse: [] },
    { renamed: true, groupResponse: {} },
  ]) {
    const blocked = await scenario(options);
    assert.equal(blocked.sync.status()[0].status, "failed", JSON.stringify(options));
    assert.equal(blocked.calls.some(call => call.options.method === "POST"), false);
    assert.deepEqual(blocked.accounts[0], blocked.before);
  }
  console.log("PASS: renamed email creates once, existing settings preserved, priority 1/concurrency 10/groups >=1.8 including exclusive/no proxy/first-serve off/fingerprint full, invalid bindings blocked");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
