import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.TOSUB2_ISOLATED_TEST, "true", "Run only in an isolated container with empty /data and no external network");
assert.deepEqual(await fs.readdir("/data"), []);
const definitions = [42, 43, 44].map((accountID, index) => ({ accountID, id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`, email: `account-${index}@example.invalid` }));
const accounts = new Map();
const deleted = [];
let migrations = 0;
let failDelete = true;
const password = crypto.randomBytes(24).toString("hex");
process.env.CONSOLE_PASSWORD_FILE = "/data/console-password";
process.env.CREDENTIAL_KEY_FILE = "/data/credential-key";
process.env.SUB2API_KEY_FILE = "/data/sub2api-key";
await fs.writeFile(process.env.CONSOLE_PASSWORD_FILE, password, { mode: 0o600 });
await fs.writeFile(process.env.CREDENTIAL_KEY_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
await fs.writeFile(process.env.SUB2API_KEY_FILE, "fake-integration-key", { mode: 0o600 });
const state = {};
for (const item of definitions) {
  const original = { name: item.email, platform: "openai", type: "oauth", credentials: { email: item.email, chatgpt_account_id: `workspace-${item.accountID}`, access_token: "FAKE_ACCESS", refresh_token: "FAKE_REFRESH" } };
  accounts.set(item.accountID, { ...original, id: item.accountID, status: "active", schedulable: true, quota_limit: 100, quota_used: item.accountID - 40, group_ids: [7], groups: [{ id: 7, name: "Test Pool" }] });
  if (item.accountID === 44) {
    original.credentials.access_token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "workspace-44" } })).toString("base64url")}.test`;
    original.credentials.chatgpt_account_id = "authsess_legacy";
    const account = accounts.get(44);
    account.credentials = { ...original.credentials, access_token: "CURRENT_ACCESS", refresh_token: "CURRENT_REFRESH", model_mapping: { model: "keep" } };
    Object.assign(account, { status: "error", error_message: "HTTP 401", schedulable: false, proxy_id: 9, extra: { account_id: "authsess_legacy", chatgpt_account_id: "authsess_legacy", custom: "keep" } });
  }
  const directory = `/data/jobs/${item.id}`;
  await fs.mkdir(directory, { recursive: true });
  const raw = JSON.stringify({ type: "sub2api-data", accounts: [original] });
  await fs.writeFile(`${directory}/sub2api-import-oauth.json`, raw);
  await fs.writeFile(`${directory}/job-meta.json`, JSON.stringify({ email: item.email, status: "completed", result_saved: true }));
  state[item.id] = { email: item.email, accountID: item.accountID, workspaceID: `workspace-${item.accountID}`, digest: crypto.createHash("sha256").update(raw).digest("hex"), status: "synced" };
}
await fs.writeFile("/data/sync-state.json", JSON.stringify(state));
const upstream = http.createServer(async (req, res) => {
  assert.equal(req.headers["x-api-key"], "fake-integration-key");
  const url = new URL(req.url, "http://sub2api:8080");
  let data;
  const match = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(url.pathname);
  if (url.pathname === "/api/v1/admin/usage/stats") {
    assert.equal(url.searchParams.get("start_date"), "1970-01-01");
    data = { total_actual_cost: 12.345678 };
  } else if (match && req.method === "GET") {
    data = accounts.get(Number(match[1]));
    if (!data) { res.writeHead(404).end(); return; }
    data = structuredClone(data);
    delete data.credentials.access_token;
    delete data.credentials.refresh_token;
  } else if (url.pathname === "/api/v1/admin/accounts/bulk-update" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(body, { account_ids: [44], credentials: { chatgpt_account_id: "workspace-44" }, extra: { account_id: "workspace-44", chatgpt_account_id: "workspace-44" } });
    Object.assign(accounts.get(44).credentials, body.credentials);
    Object.assign(accounts.get(44).extra, body.extra);
    migrations++;
    data = { success: 1, failed: 0, success_ids: [44] };
  } else if (match && req.method === "DELETE") {
    const accountID = Number(match[1]);
    if (accountID === 43 && failDelete) { res.writeHead(503).end(); return; }
    deleted.push(accountID);
    accounts.delete(accountID);
    data = {};
  } else {
    throw new Error(`Unexpected upstream request: ${req.method} ${url.pathname}`);
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: 0, data }));
});
await new Promise(resolve => upstream.listen(8080, "127.0.0.1", resolve));
const base = "http://127.0.0.1:4399";
const headers = { Authorization: "Basic " + Buffer.from(`admin:${password}`).toString("base64"), "content-type": "application/json" };
let child;
let exited;
let output = "";
async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs"], { cwd: "/opt/tosub2", env: { ...process.env, TOSUB2_AUTO_REAUTH: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  exited = new Promise(resolve => child.once("exit", resolve));
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    try {
      const response = await fetch(base + "/api/bootstrap", { headers });
      if (response.ok) {
        const bootstrap = await response.json();
        headers["x-console-token"] = bootstrap.token;
        assert.equal(bootstrap.features.linkedAccounts, true);
        return;
      }
    } catch {}
    await delay(100);
  }
  throw new Error("Start timed out: " + output);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (!await Promise.race([exited.then(() => true), delay(5000).then(() => false)])) { child.kill("SIGKILL"); await exited; throw new Error("Shutdown timed out"); }
}
async function post(endpoint, body) {
  const response = await fetch(base + endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
try {
  await start();
  for (let attempt = 0; attempt < 100 && migrations === 0; attempt++) await delay(100);
  assert.equal(migrations, 1, "startup repairs a legacy binding even when its output digest is unchanged");
  const migrated = accounts.get(44);
  assert.equal(migrated.credentials.access_token, "CURRENT_ACCESS");
  assert.equal(migrated.credentials.refresh_token, "CURRENT_REFRESH");
  assert.deepEqual(migrated.credentials.model_mapping, { model: "keep" });
  assert.equal(migrated.extra.custom, "keep");
  assert.equal(migrated.status, "error");
  assert.equal(migrated.error_message, "HTTP 401");
  assert.equal(migrated.schedulable, false);
  assert.equal(migrated.proxy_id, 9);
  assert.equal(migrated.quota_limit, 100);
  assert.deepEqual(migrated.group_ids, [7]);
  assert.equal((await fetch(base + "/api/jobs/delete-batch", { method: "POST" })).status, 401);
  assert.equal((await fetch(base + "/api/linked-accounts", { method: "POST", headers: { ...headers, Origin: "https://evil.invalid" }, body: "{}" })).status, 403);
  const detail = await post("/api/linked-accounts", { ids: definitions.map(item => item.id) });
  assert.equal(detail.items.length, 3);
  assert.equal(detail.items[0].groups[0].name, "Test Pool");
  assert.equal(detail.items[0].userCost, 12.345678);
  assert.equal(detail.items[0].quota.supported, false);
  assert.equal(detail.items[0].quota.total, null);
  assert.equal(detail.items[0].quota.used, null);
  assert.equal(detail.items[0].schedulable, true);
  assert.equal(JSON.stringify(detail).includes("FAKE_"), false);
  const partial = await post("/api/jobs/delete-batch", { ids: definitions.slice(0, 2).map(item => item.id), deleteLinkedAccounts: true, links: detail.items });
  assert.equal(partial.deleted, 1);
  assert.equal(partial.failed, 1);
  assert.equal(partial.results[1].email, definitions[1].email);
  assert.deepEqual(deleted, [42]);
  await stop();
  await start();
  const sync = await (await fetch(base + "/api/auto-sync", { headers })).json();
  assert.equal(sync.items.find(item => item.id === definitions[1].id).status, "deleting");
  failDelete = false;
  const retried = await post("/api/jobs/delete-batch", { ids: [definitions[1].id], deleteLinkedAccounts: true, links: detail.items });
  assert.equal(retried.deleted, 1);
  const localOnly = await post("/api/jobs/delete-batch", { ids: [definitions[2].id] });
  assert.equal(localOnly.deleted, 1);
  assert.equal(accounts.has(44), true);
  assert.equal(migrations, 1, "restart does not repeat metadata writes");
  assert.deepEqual(deleted, [42, 43]);
  const page = await (await fetch(base + "/api/jobs", { headers })).json();
  assert.equal(page.jobs.length, 0);
  console.log("PASS: production API legacy binding migration without token replay, preserved 401/configuration, authentication, group/cost readback, redaction, partial delete, restart fencing, retry and local-only default");
} finally {
  await stop();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
}
