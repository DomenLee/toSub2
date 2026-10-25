import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";

export function usageFixture() {
  const jobs = [1, 2].map(index => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, email: `usage-${index}@example.invalid`, status: "completed", canDownload: true, createdAt: new Date().toISOString(), prompt: "已完成", attempt: 1 }));
  const fresh = { updatedAt: new Date().toISOString(), fiveHour: { state: "fresh", remaining: 80, used: 20, resetAt: new Date(Date.now() + 3600000).toISOString() }, sevenDay: { state: "fresh", remaining: 40, used: 60, resetAt: new Date(Date.now() + 86400000).toISOString() } };
  const items = jobs.map((job, index) => ({ id: job.id, email: job.email, accountID: 42 + index, status: "ready", accountStatus: "active", schedulable: true, quota: { supported: false }, groups: index ? [{ id: 7, name: "Pro 主力组" }] : [{ id: 7, name: "Pro 主力组" }, { id: 8, name: "混合备用组" }], usage: index ? { ...fresh, updatedAt: new Date(Date.now() - 3600000).toISOString(), fiveHour: { ...fresh.fiveHour, state: "stale" }, sevenDay: { ...fresh.sevenDay, state: "stale" } } : fresh, userCost: 12.345678 }));
  return { jobs, items };
}

export async function testUsageUI(directory) {
  const assets = path.join(directory, "web/dist/assets");
  const bundle = (await fs.readdir(assets)).find(name => name.endsWith(".js"));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://console.example.invalid/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.Response = Response;
  const document = dom.window.document;
  const { jobs, items } = usageFixture();
  const calls = [];
  let trendFailure = false;
  let pausedTrend = false;
  let release;
  let trendSignal;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  dom.window.fetch = async (endpoint, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push(endpoint);
    if (endpoint === "/api/auth/session") return json({ username: "admin", token: "FAKE", expiresIn: 1800000 });
    if (endpoint === "/api/bootstrap") return json({ token: "FAKE", features: { linkedAccounts: true, bulkActions: true, usageInsights: true } });
    if (endpoint === "/api/jobs/query" || endpoint.startsWith("/api/jobs?")) return json({ jobs, selection: jobs, stats: {}, pagination: { page: 1, totalPages: 1, total: 2 } });
    if (endpoint === "/api/linked-accounts") return json({ items: items.filter(item => body.ids.includes(item.id)) });
    if (endpoint === "/api/group-usage/trend") {
      if (pausedTrend) { trendSignal = options.signal; await new Promise(resolve => { release = resolve; }); }
      if (trendFailure) return json({ error: "趋势服务暂不可用" }, 503);
      return json({ groupID: body.groupID, groupName: "Pro 主力组", updatedAt: new Date().toISOString(), points: Array.from({ length: 7 }, (_, index) => ({ date: `2026-10-${19 + index}`, requests: 10 + index, tokens: 1000 + index * 100, cost: 0.1 + index * 0.1 })) });
    }
    if (endpoint === "/api/account-usage/refresh") return json({ item: items[0], retryAt: new Date(Date.now() + 600000).toISOString(), error: "账号 #42 暂未取得完整的新快照；请稍后刷新快照查看。" });
    return json({ items: [], repair: {} });
  };
  async function until(condition) {
    for (let attempt = 0; attempt < 100; attempt++) { if (condition()) return; await delay(20); }
    throw new Error("Usage UI condition timed out: " + document.body.textContent);
  }
  const button = label => [...document.querySelectorAll("button")].find(value => value.textContent.trim() === label);
  const count = endpoint => calls.filter(value => value === endpoint).length;
  try {
    dom.window.eval(await fs.readFile(path.join(assets, bundle), "utf8"));
    await until(() => document.querySelector('[aria-label="账号概览"]')?.textContent.includes("已核实 1/2"));
    assert.equal(count("/api/account-usage/refresh"), 0);
    assert.equal(count("/api/group-usage/trend"), 0);
    document.querySelector(".usage-panel-toggle").click();
    await until(() => document.querySelectorAll(".usage-group-card").length === 2);
    assert.match(document.querySelector(".usage-group-card").textContent, /80.0%/);
    assert.match(document.querySelector(".usage-group-card").textContent, /有效 1\/2/);
    assert.equal(count("/api/group-usage/trend"), 0, "opening group summary must not scan trends");
    button("查看 Pro 主力组 趋势").click();
    await until(() => document.querySelectorAll(".usage-bar-column").length === 7);
    assert.match(document.querySelector(".usage-trend").textContent, /全部请求日志/);
    button("Token 数").click();
    await until(() => document.querySelector(".usage-trend-total").textContent.includes("Token 数"));
    assert.equal(count("/api/group-usage/trend"), 1, "metric switching uses the same response");
    button("用户扣费").click();
    await until(() => document.querySelector(".usage-trend-total").textContent.includes("$2.8000"));
    trendFailure = true;
    button("刷新趋势").click();
    await until(() => document.querySelector(".usage-trend [role=alert]")?.textContent.includes("Pro 主力组"));
    assert.equal(document.querySelectorAll(".usage-bar-column").length, 7, "failed refresh retains previous chart with an explicit error");
    trendFailure = false;
    pausedTrend = true;
    button("查看 混合备用组 趋势").click();
    await until(() => release);
    document.querySelector(".usage-panel-toggle").click();
    await until(() => !document.querySelector(".usage-trend"));
    assert.equal(trendSignal.aborted, true, "collapsing a pending trend cancels the request");
    release();
    button("账号详情").click();
    await until(() => button("更新额度"));
    assert.match(document.querySelector('[role="dialog"]').textContent, /剩余 80.0%/);
    assert.equal(count("/api/account-usage/refresh"), 0, "opening account detail must not probe models");
    button("更新额度").click();
    await until(() => document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes("账号 #42"));
    assert.equal(count("/api/account-usage/refresh"), 1);
    assert.equal([...document.querySelectorAll('[role="dialog"] button')].some(value => value.disabled && value.textContent.includes("分钟后可更新")), true);
    console.log("PASS: compiled usage UI, snapshot coverage, lazy trends, metric switching, visible errors, cancellation and explicit refresh cooldown");
  } finally { dom.window.close(); }
}
