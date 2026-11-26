import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-manual-email-"));
const outputRoot = path.join(root, "output");
const baseUrl = `http://127.0.0.1:${await availablePort()}`;
const mailbox = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("[]");
});
await new Promise((resolve) => mailbox.listen(0, "127.0.0.1", resolve));
const mailApiUrl = `http://127.0.0.1:${mailbox.address().port}/messages`;
let child;
let childExit;
let headers;
let logs = "";

try {
  await fs.cp(path.join(projectRoot, "src"), path.join(root, "src"), { recursive: true });
  for (const name of ["web", "node_modules"]) await fs.symlink(path.join(projectRoot, name), path.join(root, name), "junction");
  const serverPath = path.join(root, "src/console-server.mjs");
  const source = await fs.readFile(serverPath, "utf8");
  assert.ok(source.includes("const MAX_ACTIVE_JOBS = 20;"));
  // Exercise the same two-slot limit used by the production patch.
  await fs.writeFile(serverPath, source.replace("const MAX_ACTIVE_JOBS = 20;", "const MAX_ACTIVE_JOBS = 2;"));
  await fs.writeFile(path.join(root, "protocol.mjs"), `
import readline from "node:readline";
await new Promise((resolve) => setTimeout(resolve, 300));
console.log("Email OTP (r=resend, q=quit):");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (value) => {
  if (value === "r") console.log("Email OTP (r=resend, q=quit):");
  else console.log("[fixture] Manual verification submitted.");
});
`);
  await start();
  const first = await create("manual-first@example.invalid");
  const second = await create("manual-second@example.invalid");
  const automatic = await create("automatic-first@example.invalid", { mailApiUrl });
  assert.equal(automatic.status, "queued", "third task must initially queue behind the two manual logins");
  await waitFor(async () => (await getJob(first.id))?.status === "email_otp" && (await getJob(second.id))?.status === "email_otp");
  await waitFor(async () => (await getJob(automatic.id))?.status === "email_otp");
  assert.equal((await getJob(first.id)).autoRetryPaused, true, "missing mailbox must pause automatic retries");
  let stats = (await page()).stats;
  assert.equal(stats.active, 1, "queued task must automatically start when manual wait releases slots");
  assert.equal(stats.waiting, 2);
  const automaticSecond = await create("automatic-second@example.invalid", { mailApiUrl });
  const queued = await create("queued@example.invalid", { mailApiUrl });
  await waitFor(async () => (await getJob(automaticSecond.id))?.status === "email_otp");
  assert.equal((await getJob(automatic.id)).autoRetryPaused, false);
  assert.equal((await getJob(queued.id)).status, "queued");
  stats = (await page()).stats;
  assert.equal(stats.active, 2, "mailbox polling must still occupy slots");
  assert.equal(stats.queued, 1);

  for (const action of ["email_otp", "resend_email"]) {
    const response = await post(`/api/jobs/${first.id}/input`, { action, value: "123456" });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /manual-first@example.invalid.*并发.*再次提交/);
    assert.equal((await getJob(first.id)).status, "email_otp");
  }
  await cancel(automatic.id);
  await waitFor(async () => (await getJob(queued.id))?.status === "email_otp");
  await cancel(automaticSecond.id);
  const submissions = await Promise.all([first, second].map((job) => post(`/api/jobs/${job.id}/input`, { action: "email_otp", value: "123456" })));
  assert.deepEqual(submissions.map((response) => response.status).sort(), [200, 409], "manual resumes must not exceed the two-slot limit");
  assert.equal((await page()).stats.active, 2);
  const resumed = submissions[0].status === 200 ? first : second;
  const waiting = submissions[0].status === 200 ? second : first;
  assert.equal((await getJob(resumed.id)).status, "working");
  assert.equal((await getJob(resumed.id)).autoRetryPaused, true);
  await cancel(queued.id);
  const resend = await post(`/api/jobs/${waiting.id}/input`, { action: "resend_email" });
  assert.equal(resend.status, 200);
  await waitFor(async () => (await getJob(waiting.id))?.status === "email_otp");
  assert.equal((await page()).stats.waiting, 1, "resend must release its slot again");
  await waitFor(async () => {
    const metadata = JSON.parse(await fs.readFile(path.join(outputRoot, waiting.id, "job-meta.json"), "utf8"));
    return metadata.auto_retry_paused === true;
  });

  await stop();
  await start();
  for (const job of [first, second]) {
    const restored = await getJob(job.id);
    assert.equal(restored.autoRetryPaused, true, "pause must survive shutdown and restart");
    assert.equal(restored.autoRepairEligible, false);
    assert.match(restored.autoRepairEligibilityReason, /人工.*自动重试/);
    assert.notEqual(restored.status, "queued");
  }
  const retry = await post(`/api/jobs/${first.id}/relogin`);
  assert.equal(retry.status, 200, "explicit manual relogin must remain available");
  await waitFor(async () => (await getJob(first.id))?.status === "email_otp");
  assert.equal((await getJob(first.id)).autoRetryPaused, true);
  const configuration = await post("/api/mail-request-config", { config: { method: "POST", url: mailApiUrl, headers: {} } });
  assert.equal(configuration.status, 200);
  const globalMailbox = await create("global-mailbox@example.invalid", { mailRequestBody: '{"mailbox_id":"fixture"}' });
  await waitFor(async () => (await getJob(globalMailbox.id))?.status === "email_otp");
  assert.equal((await getJob(globalMailbox.id)).autoRetryPaused, false, "global POST mailbox must remain automatic");
  assert.equal((await page()).stats.active, 1);
  console.log("PASS: manual email pause, queue progress, mailbox polling, resume concurrency, resend, persistence and explicit relogin");
} catch (error) {
  error.message += `\nConsole output:\n${logs}`;
  throw error;
} finally {
  await stop();
  mailbox.closeAllConnections?.();
  await new Promise((resolve) => mailbox.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

async function start() {
  child = spawn(process.execPath, [path.join(root, "src/console-server.mjs"), "--port", new URL(baseUrl).port], {
    cwd: root,
    env: {
      ...process.env,
      ONBOARDING_OUTPUT_ROOT: outputRoot,
      TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"),
      ONBOARDING_PROTOCOL_SCRIPT: path.join(root, "protocol.mjs"),
      TOSUB2_TLS_PROFILE: "chrome142",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-10_000); });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`console exited: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);
      if (!response.ok) return false;
      headers = { "content-type": "application/json", "x-console-token": (await response.json()).token };
      return true;
    } catch { return false; }
  });
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exit = await Promise.race([childExit, delay(5_000).then(() => null)]);
  if (!exit) {
    child.kill("SIGKILL");
    await childExit;
    throw new Error("console did not stop gracefully");
  }
  assert.equal(exit.code, 0, logs);
}

async function create(email, config = {}) {
  const response = await post("/api/jobs", { email, ...config });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).job;
}
async function cancel(id) {
  const response = await post(`/api/jobs/${id}/cancel`);
  assert.equal(response.status, 200);
}
function post(endpoint, body = {}) {
  return fetch(`${baseUrl}${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function page() {
  return (await fetch(`${baseUrl}/api/jobs`, { headers })).json();
}
async function getJob(id) {
  return (await page()).jobs.find((job) => job.id === id);
}
async function waitFor(predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error("condition did not become true before timeout");
}
function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
