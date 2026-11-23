import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-change-email-"));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
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
  while (Date.now() - started < 15_000) {
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
  assert.equal(bootstrap.features.emailChange, true);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "old@example.com", password: "OldPassword_123!" }),
  });
  const createdPayload = await created.json();
  assert.equal(created.status, 201, JSON.stringify(createdPayload));
  const jobId = createdPayload.job.id;
  await waitForJob(headers, jobId, (job) => job.status === "completed" && job.canChangeEmail);

  const invalid = await fetch(`${baseUrl}/api/jobs/${jobId}/change-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ newEmail: "not-an-email", mailApiUrl: "https://mail.example/latest" }),
  });
  assert.equal(invalid.status, 400);
  const same = await fetch(`${baseUrl}/api/jobs/${jobId}/change-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ newEmail: "OLD@example.com", mailApiUrl: "https://mail.example/latest" }),
  });
  assert.equal(same.status, 400);

  const other = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "other@example.com", password: "OtherPassword_123!" }),
  });
  const otherId = (await other.json()).job.id;
  await waitForJob(headers, otherId, (job) => job.status === "completed");
  const duplicate = await fetch(`${baseUrl}/api/jobs/${jobId}/change-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ newEmail: "other@example.com", mailApiUrl: "https://mail.example/latest" }),
  });
  assert.equal(duplicate.status, 409);

  const occupied = await fetch(`${baseUrl}/api/jobs/${jobId}/change-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ newEmail: "fail@example.com", mailApiUrl: "https://mail.example/latest?token=mailbox-secret" }),
  });
  assert.equal(occupied.status, 200, await occupied.clone().text());
  const occupiedJob = await waitForJob(headers, jobId, (job) => job.email === "old@example.com" && job.emailChangeError);
  assert.match(occupiedJob.emailChangeError, /占用/);
  assert.equal(occupiedJob.canChangeEmail, true);

  const started = await fetch(`${baseUrl}/api/jobs/${jobId}/change-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      newEmail: "new@example.com",
      mailApiUrl: "https://mail.example/latest?token=mailbox-secret",
      mailRequestBody: "",
    }),
  });
  assert.equal(started.status, 200, await started.clone().text());
  const changed = await waitForJob(headers, jobId, (job) => job.email === "new@example.com" && job.status === "completed");
  assert.equal(changed.pendingNewEmail, null);
  assert.equal(changed.emailChangeRemotePending, false);
  const logResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers });
  const logText = await logResponse.text();
  assert.equal(logText.includes("mailbox-secret"), false);
  assert.equal(logText.includes("OldPassword_123!"), false);
  const exported = await fetch(`${baseUrl}/api/jobs/export-source`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId] }),
  });
  const source = await exported.text();
  assert.match(source, /new@example.com/);
  assert.match(source, /mailbox-secret/);
  assert.equal(source.includes("old@example.com"), false);

  const imported = await fetch(`${baseUrl}/api/email-pool/import`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: [
        "pool-a@example.com----https://mail.example/latest?token=mailbox-secret",
        "pool-b@example.com----https://mail.example/latest?token=mailbox-secret",
        "fail@example.com----https://mail.example/latest?token=mailbox-secret",
      ].join("\n"),
    }),
  });
  const importedPayload = await imported.json();
  assert.equal(imported.status, 200, JSON.stringify(importedPayload));
  assert.equal(importedPayload.available, 3);
  assert.equal(JSON.stringify(importedPayload).includes("mailbox-secret"), false);

  const pooledAccount = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "pool-source@example.com", password: "PoolPassword_123!" }),
  });
  const pooledId = (await pooledAccount.json()).job.id;
  await waitForJob(headers, pooledId, (job) => job.status === "completed" && job.canChangeEmail);
  const assigned = await fetch(`${baseUrl}/api/jobs/${pooledId}/change-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ usePool: true }),
  });
  assert.equal(assigned.status, 200, await assigned.clone().text());
  const assignedJob = await waitForJob(headers, pooledId, (job) => job.email === "pool-a@example.com" && job.status === "completed");
  assert.equal(assignedJob.emailChangeRemotePending, false);
  const afterAssign = await fetch(`${baseUrl}/api/email-pool`, { headers });
  const afterAssignPayload = await afterAssign.json();
  assert.equal(afterAssignPayload.items.find((item) => item.email === "pool-a@example.com").status, "used");
  assert.equal(afterAssignPayload.available, 2);

  const failedPool = await fetch(`${baseUrl}/api/jobs/${otherId}/change-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ usePool: true }),
  });
  assert.equal(failedPool.status, 200, await failedPool.clone().text());
  await waitForJob(headers, otherId, (job) => job.email === "pool-b@example.com");
  const blocked = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "pool-fail-source@example.com", password: "PoolPassword_123!" }),
  });
  const blockedSourceId = (await blocked.json()).job.id;
  await waitForJob(headers, blockedSourceId, (job) => job.canChangeEmail);
  const blockedChange = await fetch(`${baseUrl}/api/jobs/${blockedSourceId}/change-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ usePool: true }),
  });
  assert.equal(blockedChange.status, 200, await blockedChange.clone().text());
  await waitForJob(headers, blockedSourceId, (job) => job.email === "pool-fail-source@example.com" && /占用/.test(job.emailChangeError || ""));
  const afterBlock = await fetch(`${baseUrl}/api/email-pool`, { headers });
  const afterBlockPayload = await afterBlock.json();
  assert.equal(afterBlockPayload.items.find((item) => item.email === "fail@example.com").status, "blocked");
  assert.equal(afterBlockPayload.available, 0);
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    childExit,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

console.log("PASS: change email console");
