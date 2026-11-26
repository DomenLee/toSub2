import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";

export async function testManualEmailUI(directory) {
  const assets = path.join(directory, "web/dist/assets");
  const bundle = (await fs.readdir(assets)).find((name) => name.endsWith(".js"));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://console.example.invalid", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const document = dom.window.document;
  dom.window.Response = Response;
  const job = {
    id: "11111111-1111-4111-8111-111111111111", email: "manual@example.invalid",
    status: "email_otp", prompt: "已暂停，等待人工输入邮箱验证码", autoRetryPaused: true,
    createdAt: new Date().toISOString(), attempt: 1,
  };
  const submissions = [];
  let canceled = false;
  let confirmation = "";
  dom.window.confirm = (message) => { confirmation = message; return true; };
  dom.window.fetch = async (endpoint, options = {}) => {
    let result = {};
    if (endpoint === "/api/auth/session") result = { username: "admin", token: "FIXTURE", expiresIn: 1800000 };
    else if (endpoint === "/api/bootstrap") result = { token: "FIXTURE", features: { bulkActions: true, cancelAll: true } };
    else if (endpoint === "/api/jobs/query" || String(endpoint).startsWith("/api/jobs?")) result = {
      jobs: [job], selection: [job], stats: { active: 0, queued: 0, waiting: 1, completed: 0 },
      pagination: { page: 1, totalPages: 1, total: 1 },
    };
    else if (endpoint === "/api/auto-sync") result = { items: [], repair: { enabled: false } };
    else if (String(endpoint).endsWith("/input")) {
      submissions.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ error: `${job.email}：当前并发名额已满，请等待进行中任务结束后再次提交验证码或重发` }), { status: 409 });
    } else if (endpoint === "/api/jobs/cancel-all") canceled = true;
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  };
  async function until(check) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (check()) return;
      await delay(20);
    }
    throw new Error(`manual email UI condition timed out: ${document.body.textContent}`);
  }
  try {
    dom.window.eval(await fs.readFile(path.join(assets, bundle), "utf8"));
    await until(() => document.querySelector(".inline-entry input"));
    await delay(50);
    assert.match(document.querySelector(".summary").textContent, /待人工\s*1/);
    assert.match(document.querySelector(".step-cell").textContent, /后续不再自动重试/);
    const input = document.querySelector(".inline-entry input");
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "123456");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await until(() => !document.querySelector(".inline-entry .submit").disabled);
    document.querySelector(".inline-entry .submit").click();
    await until(() => document.querySelector('.step-cell [role="alert"]'));
    assert.equal(submissions[0].action, "email_otp");
    assert.equal(input.value, "123456", "full concurrency must retain the user's input");
    assert.match(document.querySelector('.step-cell [role="alert"]').textContent, /manual@example.invalid.*并发.*再次提交/);
    const resend = [...document.querySelectorAll(".inline-entry button")].find((button) => button.textContent.includes("重发"));
    await until(() => !resend.disabled);
    resend.click();
    await until(() => submissions.length === 2);
    assert.equal(submissions[1].action, "resend_email");
    const cancelAll = document.querySelector(".stop-all-button");
    assert.ok(cancelAll && !cancelAll.disabled, "manual-only tasks must retain the stop-all action");
    cancelAll.click();
    await until(() => canceled);
    assert.match(confirmation, /1 条/);
    console.log("PASS: manual email waiting count, local resume error, preserved code, resend and cancel-all");
  } finally {
    dom.window.close();
  }
}
