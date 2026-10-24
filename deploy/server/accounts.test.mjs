import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAccounts } from "./accounts.mjs";
import { createSync } from "./sync.mjs";
import { accountState, configuredQuota } from "../../web/src/account-state.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-accounts-"));
const email = "account@example.invalid";
const source = { name: email, platform: "openai", type: "oauth", credentials: { email, chatgpt_account_id: "workspace-a", access_token: "FAKE_ACCESS", refresh_token: "FAKE_REFRESH" } };
const raw = JSON.stringify({ type: "sub2api-data", accounts: [source] });
const digest = crypto.createHash("sha256").update(raw).digest("hex");
let counter = 0;

async function fixture({ linked = true, remoteMissing = false, mismatch = false, failStats = false, failDelete = false, failLocal = false, busy = false } = {}) {
  const directory = path.join(root, String(++counter));
  await fs.mkdir(directory);
  const job = { id: "job-a", email, status: busy ? "working" : "completed", resultSaved: true, outputPath: path.join(directory, "oauth.json") };
  await fs.writeFile(job.outputPath, raw);
  const stateFile = path.join(directory, "sync.json");
  if (linked) await fs.writeFile(stateFile, JSON.stringify({ [job.id]: { email, accountID: 42, workspaceID: "workspace-a", status: "synced", digest } }));
  const jobs = new Map([[job.id, job]]);
  const calls = [];
  let exists = !remoteMissing;
  const request = async (endpoint, options = {}) => {
    calls.push({ endpoint, options });
    if (endpoint.startsWith("/api/v1/admin/usage/stats?")) {
      if (failStats) throw new Error("stats unavailable");
      const query = new URL(endpoint, "http://mock.invalid").searchParams;
      assert.equal(query.get("account_id"), "42");
      assert.equal(query.get("start_date"), "1970-01-01");
      return { total_actual_cost: 1.234567 };
    }
    if (options.method === "DELETE") {
      if (failDelete) {
        exists = false;
        throw new Error("连接超时，结果未知");
      }
      exists = false;
      return {};
    }
    if (!exists) throw Object.assign(new Error("not found"), { status: 404 });
    return { ...source, id: 42, status: "active", schedulable: true, quota_limit: 100, quota_used: 12.5, credentials: { ...source.credentials, chatgpt_account_id: mismatch ? "wrong-workspace" : "workspace-a" }, group_ids: [7, 8], groups: [{ id: 7, name: "Main" }], account_groups: [{ group_id: 8, group: { name: "Backup" } }] };
  };
  const sync = await createSync({ jobs, request, stateFile });
  const local = [];
  const accounts = createAccounts({ jobs, sync, request, lock: async (target, operation) => operation(), removeLocal: async target => {
    local.push(target);
    if (failLocal) throw new Error("本地目录不可写");
    jobs.delete(job.id);
  } });
  return { accounts, sync, jobs, job, stateFile, request, local, calls };
}

try {
  assert.equal(accountState({ status: "working" }, { status: "unlinked" }).label, "待完成授权");
  assert.equal(accountState({ status: "completed" }, { status: "unlinked" }).label, "待同步");
  assert.equal(accountState({}, { status: "unlinked", syncStatus: "failed" }).label, "同步失败");
  assert.equal(accountState({}, { status: "missing" }).attention, true);
  assert.equal(accountState({}, { status: "error", accountID: 42 }).label, "读取失败");
  assert.deepEqual(configuredQuota([{ status: "ready", quota: { supported: false, total: 100 } }], "total"), { text: "未提供", count: 0 });
  assert.deepEqual(configuredQuota([{ status: "ready", quota: { total: 100 } }, { status: "ready", quota: { total: 0 } }], "total"), { text: "含不限额", count: 2 });
  assert.deepEqual(configuredQuota([{ status: "ready", quota: { used: 2 } }, { status: "error" }], "used"), { text: "$2.00", count: 1 });
  const valid = await fixture();
  const details = await valid.accounts.details([valid.job]);
  assert.equal(details[0].userCost, 1.234567);
  assert.deepEqual(details[0].quota, { supported: false, total: null, used: null }, "OAuth quota must not be inferred from generic account fields");
  const callsBeforeSummary = valid.calls.filter(call => call.endpoint.includes("/usage/stats?")).length;
  await valid.accounts.details([valid.job], false);
  assert.equal(valid.calls.filter(call => call.endpoint.includes("/usage/stats?")).length, callsBeforeSummary, "summary polling must not query lifetime usage stats");
  assert.equal(details[0].schedulable, true);
  assert.deepEqual(details[0].groups, [{ id: 7, name: "Main" }, { id: 8, name: "Backup" }]);
  assert.equal(JSON.stringify(details).includes("FAKE_"), false);
  assert.equal((await valid.accounts.remove([valid.job], true, details)).deleted, 1);
  assert.equal(valid.calls.filter(call => call.options.method === "DELETE").length, 1);
  assert.equal(valid.jobs.size, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(valid.stateFile, "utf8")), {});

  const localOnly = await fixture();
  assert.equal((await localOnly.accounts.remove([localOnly.job], false)).deleted, 1);
  assert.equal(localOnly.calls.length, 0);

  const mismatch = await fixture({ mismatch: true });
  const mismatchInfo = (await mismatch.accounts.details([mismatch.job]))[0];
  assert.equal(mismatchInfo.status, "error");
  assert.equal(mismatchInfo.code, "binding_mismatch");
  assert.equal(mismatchInfo.accountID, 42);
  assert.doesNotMatch(mismatchInfo.error, /未执行删除/);
  assert.equal((await mismatch.accounts.remove([mismatch.job], true, [{ id: mismatch.job.id, accountID: 42 }])).failed, 1);
  assert.equal(mismatch.local.length, 0);
  assert.equal(mismatch.calls.some(call => call.options.method === "DELETE"), false);

  const changed = await fixture();
  assert.equal((await changed.accounts.remove([changed.job], true, [{ id: changed.job.id, accountID: 99 }])).failed, 1);
  assert.equal(changed.calls.some(call => call.options.method === "DELETE"), false);

  const unlinked = await fixture({ linked: false });
  const unlinkedInfo = await unlinked.accounts.details([unlinked.job]);
  assert.equal(unlinkedInfo[0].status, "unlinked");
  assert.equal((await unlinked.accounts.remove([unlinked.job], true, unlinkedInfo)).deleted, 1);
  assert.equal(unlinked.calls.length, 0);

  const missing = await fixture({ remoteMissing: true });
  const missingInfo = await missing.accounts.details([missing.job]);
  assert.equal(missingInfo[0].status, "missing");
  assert.equal((await missing.accounts.remove([missing.job], true, missingInfo)).deleted, 1);

  const busy = await fixture({ busy: true });
  assert.equal((await busy.accounts.remove([busy.job], true, [{ id: busy.job.id, accountID: 42 }])).failed, 1);
  assert.equal(busy.calls.length, 0);

  const statsError = await fixture({ failStats: true });
  const unavailable = await statsError.accounts.details([statsError.job]);
  assert.equal(unavailable[0].userCost, null);
  assert.match(unavailable[0].statsError, /读取失败/);

  const uncertain = await fixture({ failDelete: true });
  const expected = [{ id: uncertain.job.id, accountID: 42 }];
  assert.equal((await uncertain.accounts.remove([uncertain.job], true, expected)).failed, 1);
  assert.equal(uncertain.sync.isDeleting(uncertain.job.id), true);
  const restored = await createSync({ jobs: uncertain.jobs, request: uncertain.request, stateFile: uncertain.stateFile });
  assert.equal(restored.isDeleting(uncertain.job.id), true);
  const previous = uncertain.calls.length;
  await restored.sync(uncertain.job, true);
  assert.equal(uncertain.calls.length, previous, "pending deletion must prevent background and forced sync after restart");
  assert.equal((await uncertain.accounts.remove([uncertain.job], true, expected)).deleted, 1, "retry accepts a now-missing previously bound account");

  const partial = await fixture({ failLocal: true });
  const result = await partial.accounts.remove([partial.job], true, [{ id: partial.job.id, accountID: 42 }]);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].remoteDeleted, true);
  assert.match(result.results[0].error, /本项目账号已删除，本地清理未完成/);

  const serial = await fixture();
  const order = [];
  const first = serial.sync.run(async () => { order.push("start"); await new Promise(resolve => setTimeout(resolve, 20)); order.push("finish"); });
  const second = serial.sync.run(() => { order.push("delete"); });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["start", "finish", "delete"]);
  console.log("PASS: linked groups, lifetime user costs, redaction, local-only default, identity guard, preview guard, missing/unlinked/busy accounts, unknown outcomes, durable deletion fencing, partial failure and serialization");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
