import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.TOSUB2_ISOLATED_TEST, "true", "Run only in an isolated container with empty /data and no network");
assert.deepEqual(await fs.readdir("/data"), []);
const email = "repair-test@example.invalid";
const id = "11111111-1111-4111-8111-111111111111";
const directory = `/data/jobs/${id}`;
const outputPath = `${directory}/sub2api-import-oauth.json`;
const original = { name: email, platform: "openai", type: "oauth", credentials: { email, chatgpt_account_id: "test-workspace", access_token: "FAKE_OLD", refresh_token: "FAKE_REFRESH" }, concurrency: 10, priority: 1 };
let account = { ...original, id: 212, status: "error", schedulable: false, error_message: "HTTP 401 token invalidated", group_ids: [7], proxy_id: 9, credentials: { ...original.credentials, model_mapping: { test: "keep" } } };
let writes = 0;
let child;
let childOutput = "";
let resolveExit;
let childExit;
const password = crypto.randomBytes(6).toString("hex");
process.env.CONSOLE_PASSWORD_FILE = "/data/console-password";
process.env.CREDENTIAL_KEY_FILE = "/data/credential-key";
process.env.SUB2API_KEY_FILE = "/data/sub2api-key";
await fs.writeFile(process.env.CONSOLE_PASSWORD_FILE, password, { mode: 0o600 });
await fs.writeFile(process.env.CREDENTIAL_KEY_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
await fs.writeFile(process.env.SUB2API_KEY_FILE, "fake-integration-key", { mode: 0o600 });
const { createCredentialStore } = await import("/opt/tosub2/src/server-security.mjs");
await createCredentialStore().save(email, { password: "FAKE_PASSWORD" });
await fs.mkdir(directory, { recursive: true });
const raw = JSON.stringify({ type: "sub2api-data", accounts: [original] });
await fs.writeFile(outputPath, raw);
await fs.writeFile(`${directory}/job-meta.json`, JSON.stringify({ email, status: "completed", result_saved: true, last_auth_automated: true, last_auth_requirements: { password: true }, has_password_credential: true }));
await fs.writeFile("/data/sync-state.json", JSON.stringify({ [id]: { email, accountID: 212, status: "synced", digest: crypto.createHash("sha256").update(raw).digest("hex"), updatedAt: new Date(Date.now() - 1000).toISOString() } }));
await fs.writeFile("/data/protocol.mjs", `import fs from "node:fs/promises";
const output = process.argv[process.argv.indexOf("--sub2api-out") + 1];
const data = JSON.parse(await fs.readFile(output, "utf8"));
data.accounts[0].credentials.access_token = "FAKE_RENEWED";
await fs.writeFile(output, JSON.stringify(data));
`);
const upstream = http.createServer(async (req, res) => {
  assert.equal(req.headers["x-api-key"], "fake-integration-key");
  let data;
  if (req.method === "GET" && req.url.includes("?")) {
    const onlyErrors = req.url.includes("status=error");
    data = { items: onlyErrors && account.status !== "error" ? [] : [account], pages: 1 };
  } else if (req.method === "GET" && req.url === "/api/v1/admin/accounts/212") {
    data = account;
  } else if (req.method === "POST" && req.url === "/api/v1/admin/accounts/212/apply-oauth-credentials") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(Object.keys(body), ["type", "credentials", "extra"]);
    account = { ...account, credentials: { ...account.credentials, ...body.credentials }, status: "active", error_message: "" };
    writes++;
    data = account;
  } else if (req.method === "POST" && req.url === "/api/v1/admin/accounts/212/clear-error") {
    account = { ...account, status: "active", error_message: "" };
    data = account;
  } else if (req.method === "POST" && req.url === "/api/v1/admin/accounts/212/schedulable") {
    account.schedulable = true;
    data = account;
  } else {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 0, data }));
});
await new Promise(resolve => upstream.listen(8080, "127.0.0.1", resolve));
const headers = { Origin: process.env.PUBLIC_ORIGIN, "content-type": "application/json" };
const base = "http://127.0.0.1:4399";
async function start() {
  childExit = new Promise(resolve => { resolveExit = resolve; });
  child = spawn(process.execPath, ["src/console-server.mjs"], { cwd: "/opt/tosub2", env: { ...process.env, TOSUB2_AUTO_REAUTH: "true", ONBOARDING_PROTOCOL_SCRIPT: "/data/protocol.mjs" }, stdio: ["ignore", "pipe", "pipe"] });
  child.once("exit", resolveExit);
  child.stdout.on("data", chunk => { childOutput += chunk; });
  child.stderr.on("data", chunk => { childOutput += chunk; });
  await until(async () => {
    const response = await fetch(base + "/api/auth/login", { method: "POST", headers, body: JSON.stringify({ username: "admin", password }) });
    if (!response.ok) return false;
    headers.Cookie = response.headers.get("set-cookie").split(";")[0];
    headers["x-console-token"] = (await response.json()).token;
    return true;
  });
}
async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) throw new Error(childOutput);
    try { if (await check()) return; } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    await delay(100);
  }
  throw new Error("Integration timed out: " + childOutput);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([childExit.then(() => true), delay(5000).then(() => false)]);
  if (!exited) { child.kill("SIGKILL"); await childExit; throw new Error("Shutdown timed out"); }
}
try {
  await start();
  assert.equal((await fetch(base + "/api/bootstrap")).status, 401);
  await until(() => account.status === "active" && account.schedulable);
  assert.equal(writes, 1);
  assert.equal(account.credentials.access_token, "FAKE_RENEWED");
  assert.equal(account.credentials.model_mapping.test, "keep");
  assert.deepEqual(account.group_ids, [7]);
  assert.equal(account.proxy_id, 9);
  const page = await (await fetch(base + "/api/jobs", { headers })).json();
  assert.equal(page.jobs[0].lastOperationType, "automatic_relogin");
  assert.equal(page.jobs[0].status, "completed");
  await stop();
  await start();
  await until(async () => {
    const result = await (await fetch(base + "/api/auto-sync", { headers })).json();
    return result.repair.items[0]?.status === "recovered";
  });
  assert.equal(writes, 1);
  console.log("PASS: production entrypoint detects 401, reuses encrypted login, reauthorizes, updates original account, preserves settings, authenticates API, recovers after restart");
} finally {
  await stop();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
}
