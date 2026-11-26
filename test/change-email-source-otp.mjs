import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-source-otp-"));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
const mailboxPort = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
let mailboxHits = 0;
const mailbox = http.createServer((req, res) => {
  mailboxHits += 1;
  const body = mailboxHits < 2
    ? "[]"
    : JSON.stringify({ code: "654321", id: "fresh-message", received_at: new Date().toISOString() });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});
await new Promise((resolve) => mailbox.listen(mailboxPort, "127.0.0.1", resolve));
const mailboxUrl = `http://127.0.0.1:${mailboxPort}/latest`;
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [
  path.join(projectRoot, "src", "console-server.mjs"),
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ONBOARDING_OUTPUT_ROOT: outputRoot,
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "credentials"),
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-change-email-protocol.mjs"),
    TOSUB2_MOCK_LOGIN_OTP: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const childExit = new Promise((resolve) => child.once("exit", resolve));

async function waitForJson(url) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(logs.slice(-2000));
}

async function waitForJob(headers, id, check) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 20_000) {
    const response = await fetch(`${baseUrl}/api/jobs`, { headers });
    const data = await response.json();
    last = data.jobs.find((job) => job.id === id);
    if (last && check(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job timeout ${JSON.stringify(last)}\n${logs.slice(-2000)}`);
}

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "source@example.com", password: "SourcePassword_123!" }),
  });
  const createdPayload = await created.json();
  assert.equal(created.status, 201, JSON.stringify(createdPayload));
  const jobId = createdPayload.job.id;
  await waitForJob(headers, jobId, (job) => job.status === "completed" && !job.mailApiUrl);

  const imported = await fetch(`${baseUrl}/api/email-pool/import`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: [
        `source@example.com----${mailboxUrl}`,
        `next-box@example.com----${mailboxUrl}?unused=1`,
      ].join("\n"),
    }),
  });
  assert.equal(imported.status, 200, await imported.clone().text());

  const started = await fetch(`${baseUrl}/api/jobs/${jobId}/change-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ usePool: true }),
  });
  assert.equal(started.status, 200, await started.clone().text());
  const completed = await waitForJob(headers, jobId, (job) => job.email === "next-box@example.com" && job.status === "completed");
  assert.equal(completed.autoRetryPaused, false, "source mailbox must continue automatic verification");
  const logText = await (await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers })).text();
  assert.match(logText, /已从收码接口自动取得新验证码并提交/);
  assert.equal(logText.includes("654321"), false);
  assert.equal(logText.includes(mailboxUrl), false);
} finally {
  child.kill("SIGTERM");
  mailbox.close();
  await Promise.race([childExit, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

console.log("PASS: change email source otp");
