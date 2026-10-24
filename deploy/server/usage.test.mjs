import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUsage, usageOf } from "./usage.mjs";
import { usageGroups, usageSummary } from "../../web/src/usage-state.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-usage-"));
let now = Date.now();
const extra = { codex_usage_updated_at: new Date(now).toISOString(), codex_5h_used_percent: 20, codex_7d_used_percent: 80, codex_5h_reset_at: new Date(now + 3600000).toISOString(), codex_7d_reset_at: new Date(now + 86400000).toISOString(), access_token: "SECRET" };
const fresh = usageOf({ extra }, now);
const entry = (accountID, overrides = {}) => ({ id: `job-${accountID}`, accountID, status: "ready", accountStatus: "active", schedulable: true, groups: [{ id: 7, name: "主力" }], usage: fresh, ...overrides });

try {
  assert.equal(fresh.fiveHour.remaining, 80);
  assert.equal(fresh.sevenDay.state, "fresh");
  assert.equal(JSON.stringify(fresh).includes("SECRET"), false);
  assert.equal(usageOf({ extra: { ...extra, codex_5h_used_percent: null } }, now).fiveHour.state, "missing");
  assert.equal(usageOf({ extra: { ...extra, codex_5h_used_percent: "" } }, now).fiveHour.state, "missing");
  assert.equal(usageOf({ extra: { ...extra, codex_5h_used_percent: "0" } }, now).fiveHour.remaining, 100);
  assert.equal(usageOf({ extra: { ...extra, codex_5h_used_percent: 120 } }, now).fiveHour.remaining, 0);
  assert.equal(usageOf({ extra: { ...extra, codex_usage_updated_at: null } }, now).fiveHour.state, "stale");
  assert.equal(usageOf({ extra: { ...extra, codex_usage_updated_at: new Date(now - 16 * 60000).toISOString() } }, now).fiveHour.state, "stale");
  const expired = usageOf({ extra: { ...extra, codex_5h_reset_at: new Date(now - 1).toISOString(), codex_5h_used_percent: 100 } }, now);
  assert.equal(expired.fiveHour.state, "stale");
  assert.equal(expired.fiveHour.used, 100, "elapsed reset must never fabricate a fresh 100% remaining quota");
  assert.equal(usageOf({ extra, rate_limit_reset_at: new Date(now + 10000).toISOString() }, now).blocked, true);
  assert.equal(usageOf({ extra, auto_pause_on_expired: true, expires_at: Math.floor(now / 1000) - 1 }, now).blocked, true);

  const entries = [entry(1), entry(1), entry(2, { usage: { ...fresh, blocked: true } }), entry(3, { usage: expired }), entry(4, { usage: usageOf({ extra: { ...extra, codex_7d_used_percent: 100 } }, now) })];
  const summary = usageSummary(entries);
  assert.equal(summary.total, 4);
  assert.equal(summary.available, 1);
  assert.equal(summary.low, 1);
  assert.equal(summary.exhausted, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.fiveHour.count, 2);
  const groups = usageGroups([entry(1, { groups: [{ id: 7, name: "主力" }, { id: 8, name: "备用" }] }), entry(2, { groups: [] })]);
  assert.deepEqual(groups.map(group => group.id), [0, 7, 8]);
  assert.equal(groups[1].total, 1);

  let calls = 0;
  let release;
  let upstreamFailure = false;
  let changed = false;
  const inspect = async job => changed ? entry(99) : entry(job.accountID);
  const stateFile = path.join(root, "refresh.json");
  const request = async endpoint => {
    calls++;
    assert.match(endpoint, /^\/api\/v1\/admin\/accounts\/\d+\/usage$/);
    assert.doesNotMatch(endpoint, /force/);
    if (upstreamFailure) throw new Error("SECRET upstream error");
    await new Promise(resolve => { release = resolve; });
    return { five_hour: { utilization: 0 } };
  };
  const service = createUsage({ request, inspect, now: () => now, stateFile });
  const first = service.refresh(entry(1));
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  const second = service.refresh(entry(1));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 1, "concurrent requests for an account share one probe");
  release();
  await Promise.all([first, second]);
  assert.match((await service.refresh(entry(1))).error, /冷却/);
  const restarted = createUsage({ request, inspect, now: () => now, stateFile });
  assert.match((await restarted.refresh(entry(1))).error, /冷却/);
  assert.equal(calls, 1, "cooldown survives restart");
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
  now += 10 * 60000 + 1;
  upstreamFailure = true;
  const failed = await restarted.refresh(entry(1));
  assert.match(failed.error, /账号 #1.*查询失败/);
  assert.equal(JSON.stringify(failed).includes("SECRET"), false);
  assert.equal(failed.item.usage.fiveHour.remaining, 80);
  assert.match((await restarted.refresh(entry(1))).error, /冷却/);

  const releases = [];
  const limited = createUsage({ stateFile: path.join(root, "limited.json"), inspect, now: () => now, request: async () => new Promise(resolve => releases.push(resolve)) });
  const active = [limited.refresh(entry(11)), limited.refresh(entry(12))];
  while (releases.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(limited.refresh(entry(13)), error => error.status === 429);
  releases.forEach(resolve => resolve({}));
  await Promise.all(active);

  let trendCalls = 0;
  let trendFailure = false;
  const trendService = createUsage({ inspect, now: () => now, request: async endpoint => {
    trendCalls++;
    const query = new URL(endpoint, "http://example.invalid");
    assert.equal(query.pathname, "/api/v1/admin/dashboard/trend");
    assert.equal(query.searchParams.get("group_id"), "7");
    assert.equal(query.searchParams.get("timezone"), "Asia/Shanghai");
    if (trendFailure) throw new Error("SECRET");
    return { trend: [{ date: query.searchParams.get("end_date"), requests: 2, total_tokens: 100, actual_cost: 1.2, credentials: "SECRET" }] };
  } });
  await assert.rejects(trendService.trend(entry(1), 99), error => error.status === 409);
  await assert.rejects(trendService.trend(entry(1), "7"), error => error.status === 400);
  assert.equal(trendCalls, 0);
  const trend = await trendService.trend(entry(1), 7);
  assert.equal(trend.points.length, 7);
  assert.equal(trend.points.reduce((sum, point) => sum + point.requests, 0), 2);
  assert.equal(JSON.stringify(trend).includes("SECRET"), false);
  await trendService.trend(entry(2), 7);
  assert.equal(trendCalls, 1, "group cache shared across accounts and browsers");
  now += 5 * 60000 + 1;
  trendFailure = true;
  const stale = await trendService.trend(entry(1), 7);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.points, trend.points);
  assert.match(stale.error, /主力.*#7/);
  await trendService.trend(entry(1), 7);
  assert.equal(trendCalls, 2, "failed trend queries back off for a minute");

  const unbound = createUsage({ inspect: async () => ({ status: "unlinked" }), request: async () => { throw new Error("must not query"); } });
  await assert.rejects(unbound.refresh({ id: "missing" }), error => error.status === 409);
  console.log("PASS: validated snapshots, stale/reset handling, group deduplication and coverage, persistent cooldown, shared probes, concurrency cap, scoped trends, caching, errors and redaction");
} finally { await fs.rm(root, { recursive: true, force: true }); }
