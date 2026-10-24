import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";

export async function testUI(directory) {
  const assets = path.join(directory, "web/dist/assets");
  const bundle = (await fs.readdir(assets)).find(name => name.endsWith(".js"));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://console.example.invalid", runScripts: "outside-only", pretendToBeVisual: true });
  const document = dom.window.document;
  let statsFail = false;
  let jobs = [1, 2].map(index => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, email: `${index === 1 ? "alpha" : "beta"}@example.invalid`, status: "completed", canDownload: true, createdAt: new Date().toISOString(), prompt: "已完成", attempt: 1 }));
  const deletedRequests = [];
  dom.window.fetch = async (endpoint, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    let result = {};
    if (endpoint === "/api/bootstrap") result = { token: "FAKE_CONSOLE_TOKEN", features: { bulkActions: true, linkedAccounts: true } };
    else if (endpoint === "/api/jobs/query" || String(endpoint).startsWith("/api/jobs?")) result = { jobs, selection: jobs, stats: { active: 0, queued: 0, completed: jobs.length }, pagination: { page: 1, totalPages: 1, total: jobs.length } };
    else if (endpoint === "/api/auto-sync") result = { items: [], repair: { enabled: false } };
    else if (endpoint === "/api/linked-accounts") result = { items: body.ids.map(id => ({ id, email: jobs.find(job => job.id === id)?.email, accountID: id.endsWith("1") ? 42 : 43, status: "ready", accountStatus: "active", schedulable: true, reauthRequired: false, quota: { total: 100, used: 12.5, dailyTotal: null, dailyUsed: null, weeklyTotal: null, weeklyUsed: null }, groups: [{ id: 7, name: "Test Pool" }], userCost: statsFail ? null : 12.345678, statsError: statsFail ? "累计扣费读取失败，请点击刷新重试" : "" })) };
    else if (endpoint === "/api/jobs/delete-batch") {
      deletedRequests.push(body);
      result = { deleted: 1, failed: 1, results: [{ id: jobs[0].id, email: jobs[0].email, accountID: 42, deleted: true, remoteDeleted: true }, { id: jobs[1].id, email: jobs[1].email, accountID: 43, deleted: false, error: "本项目接口返回 HTTP 503；请核对该账号后重试删除" }] };
      jobs = jobs.slice(1);
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  };
  async function until(check) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (check()) return;
      await delay(20);
    }
    throw new Error("UI condition timed out: " + document.body.textContent);
  }
  const button = text => [...document.querySelectorAll("button")].find(item => item.textContent.trim() === text);
  try {
    dom.window.eval(await fs.readFile(path.join(assets, bundle), "utf8"));
    await until(() => button("批量添加任务"));
    assert.equal(button("添加任务"), undefined, "single task creation must stay hidden");
    assert.equal(button("筛选账号"), undefined, "email filter entry must stay hidden");
    assert.equal(document.querySelector('[aria-label="接码平台配置"]'), null, "SMS provider toolbar must stay hidden");
    assert.equal(document.querySelector('[aria-label="邮件接码请求配置"]'), null, "mail API toolbar must stay hidden");
    await until(() => button("更多批量操作"));
    button("更多批量操作").click();
    await until(() => document.querySelector(".bulk-advanced-actions")?.classList.contains("open"));
    assert.equal(document.querySelector(".bulk-advanced-actions")?.classList.contains("open"), true, "bulk actions should expand on demand");
    button("收起更多操作").click();
    await until(() => !document.querySelector(".bulk-advanced-actions")?.classList.contains("open"));
    assert.equal(document.querySelector(".bulk-advanced-actions")?.classList.contains("open"), false, "bulk actions should collapse again");
    await until(() => document.querySelector(".job-row.mobile-collapsed"));
    const firstJobRow = document.querySelector(".job-row");
    firstJobRow.querySelector("button.account-collapse-toggle").click();
    await until(() => !firstJobRow.classList.contains("mobile-collapsed"));
    firstJobRow.querySelector("button.account-collapse-toggle").click();
    await until(() => firstJobRow.classList.contains("mobile-collapsed"));
    await until(() => button("账号详情"));
    assert.match(document.querySelector('[aria-label="账号概览"]').textContent, /当前在线2/);
    assert.match(document.querySelector('[aria-label="账号概览"]').textContent, /已使用额度\$25\.00/);
    await until(() => button("账号详情"));
    button("账号详情").click();
    await until(() => document.querySelector('[role="dialog"]')?.textContent.includes("12.345678"));
    assert.match(document.querySelector('[role="dialog"]').textContent, /Test Pool/);
    statsFail = true;
    button("刷新").click();
    await until(() => document.querySelector('[role="dialog"]')?.textContent.includes("累计扣费读取失败"));
    assert.match(document.querySelector('[role="dialog"]').textContent, /暂不可用/);
    button("关闭").click();
    statsFail = false;
    await until(() => !document.querySelector('[role="dialog"]'));
    document.querySelector('input[aria-label="选择 alpha@example.invalid"]').click();
    document.querySelector('input[aria-label="选择 beta@example.invalid"]').click();
    await until(() => !button("批量删除").disabled);
    button("批量删除").click();
    await until(() => document.querySelector('[role="dialog"]')?.textContent.includes("Test Pool"));
    const checkbox = document.querySelector('[role="dialog"] input[type="checkbox"]');
    assert.equal(checkbox.checked, false, "linked deletion must default to unchecked");
    assert.match(document.querySelector('[role="dialog"]').textContent, /Spark 影子账号/);
    checkbox.click();
    await until(() => button("删除任务及关联账号") && !button("删除任务及关联账号").disabled);
    button("删除任务及关联账号").click();
    await until(() => document.querySelector('[role="dialog"]')?.textContent.includes("HTTP 503"));
    assert.equal(deletedRequests[0].deleteLinkedAccounts, true);
    assert.equal(deletedRequests[0].links.length, 2);
    const alerts = [...document.querySelectorAll('[role="dialog"] [role="alert"]')].map(item => item.textContent).join(" ");
    assert.match(alerts, /beta@example.invalid.*账号 #43/);
    assert.match(alerts, /重试删除/);
    assert.match(document.querySelector('[role="dialog"]').textContent, /关联账号和本地任务已删除/);
    console.log("PASS: compiled UI group/cost details, unavailable-not-zero stats, default-unchecked deletion, shadow warning and account-specific partial failure modal");
  } finally {
    dom.window.close();
  }
}
