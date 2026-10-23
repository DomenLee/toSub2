import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRepair, isAuthFailure } from "./repair.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-repair-"));
const account = { id: 212, platform: "openai", type: "oauth", status: "error", error_message: "HTTP 401 token invalidated", credentials: { email: "test@example.invalid", chatgpt_account_id: "workspace-a" } };
const job = { id: "job-212", email: account.credentials.email, status: "completed", outputPath: path.join(root, "output.json") };
let time = Date.now();
let revision = "original";
let item = { id: job.id, accountID: 212, status: "synced", updatedAt: new Date(time - 1000).toISOString() };
let starts = 0;
let requests = 0;
let remote = [account];
let eligible = true;
let fail = false;
const options = {
  jobs: new Map([[job.id, job]]),
  sync: { status: () => [item], revision: () => revision },
  request: async endpoint => {
    requests++;
    if (fail) throw new Error("private upstream error");
    return endpoint.includes("?") ? { items: remote, pages: 1 } : remote.find(item => item.id === account.id);
  },
  renew: async target => {
    if (!eligible) return { started: false, reason: "缺少邮箱收码 API" };
    starts++;
    target.status = "starting";
    return { started: true };
  },
  now: () => time,
  enabled: true,
  stateFile: path.join(root, "repair.json"),
};

try {
  await fs.writeFile(job.outputPath, JSON.stringify({ accounts: [account] }));
  assert.equal(isAuthFailure(account), true);
  for (const change of [{ error_message: "HTTP 429" }, { error_message: "HTTP 401 account_deactivated" }, { parent_account_id: 1 }, { type: "apikey" }, { status: "active" }]) assert.equal(isAuthFailure({ ...account, ...change }), false);
  const disabled = await createRepair({ ...options, enabled: false });
  await disabled.check();
  assert.equal(requests, 0);

  const monitor = await createRepair(options);
  await Promise.all([monitor.check(), monitor.check()]);
  assert.equal(starts, 1);
  assert.equal(monitor.status().items[0].accountID, 212);
  await monitor.check();
  assert.equal(starts, 1);
  job.status = "mfa_otp";
  await monitor.check();
  assert.equal(monitor.status().items[0].status, "waiting");
  job.status = "failed";
  await monitor.check();
  assert.equal(monitor.status().items[0].status, "failed");

  const restored = await createRepair(options);
  await restored.check();
  assert.equal(starts, 1);
  time += 15 * 60_000;
  await restored.check();
  assert.equal(starts, 2);
  job.status = "completed";
  item = { ...item, status: "failed", accountID: undefined };
  time += 15 * 60_000;
  await restored.check();
  assert.equal(starts, 2);
  assert.equal(restored.status().items[0].status, "sync_pending");
  revision = "renewed";
  item = { ...item, accountID: 212, status: "synced", updatedAt: new Date(time).toISOString() };
  remote = [];
  await restored.check();
  assert.equal(restored.status().items[0].status, "recovered");

  remote = [account];
  await restored.check();
  assert.equal(starts, 3);
  job.status = "failed";
  time += 15 * 60_000;
  await restored.check();
  assert.equal(starts, 3);
  assert.equal(restored.status().items[0].status, "limited");
  assert.equal((await fs.stat(options.stateFile)).mode & 0o777, 0o600);

  time += 24 * 60 * 60_000;
  eligible = false;
  await restored.check();
  assert.equal(starts, 3);
  assert.equal(restored.status().items[0].status, "blocked");
  assert.equal(restored.status().items[0].attempts, 0);
  eligible = true;
  account.credentials.chatgpt_account_id = "different-workspace";
  await restored.check();
  assert.equal(starts, 3);
  assert.match(restored.status().items[0].message, /工作区/);
  account.credentials.chatgpt_account_id = "workspace-a";
  remote = [{ ...account, id: 999 }];
  await restored.check();
  assert.equal(starts, 3);
  fail = true;
  await restored.check();
  assert.match(restored.status().error, /检测失败/);
  assert.equal(JSON.stringify(restored.status()).includes("private upstream error"), false);
  await restored.stop();
  fail = false;
  remote = [account];
  await restored.check();
  assert.equal(starts, 3);
  console.log("PASS: 401 scope, disabled default, concurrency, manual verification, cooldown, daily limit, restart, sync retry, identity checks, safe errors, shutdown");
} finally { await fs.rm(root, { recursive: true, force: true }); }
