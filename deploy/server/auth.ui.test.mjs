import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";

export async function testAuthUI(directory) {
  const assets = path.join(directory, "web/dist/assets");
  const bundle = (await fs.readdir(assets)).find(name => name.endsWith(".js"));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://console.example.invalid/", runScripts: "outside-only", pretendToBeVisual: true });
  const document = dom.window.document;
  dom.window.Response = Response;
  let authenticated = false;
  let mode = "wrong";
  let logoutFailed = false;
  let expire = false;
  let release;
  let logins = 0;
  const calls = [];
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const session = { username: "admin", token: "FAKE_SESSION_TOKEN", expiresIn: 3 * 24 * 60 * 60_000 };
  dom.window.fetch = async (endpoint, options = {}) => {
    calls.push({ endpoint, options });
    if (endpoint === "/api/auth/session") return json(authenticated ? session : { error: "登录已失效" }, authenticated ? 200 : 401);
    if (endpoint === "/api/auth/login") {
      logins++;
      if (mode === "network") throw new Error("fake network failure");
      if (mode === "wrong") return json({ error: "账号或密码不正确，请检查后重试。" }, 401);
      if (mode === "limited") return json({ error: "登录尝试过于频繁，请稍后重试。", retryAfter: 1 }, 429);
      if (mode === "pending") await new Promise(resolve => { release = resolve; });
      authenticated = true;
      return json(session);
    }
    if (endpoint === "/api/auth/logout") {
      if (logoutFailed) throw new Error("fake network failure");
      authenticated = false;
      return json({ loggedOut: true });
    }
    if (expire && endpoint.startsWith("/api/jobs")) { authenticated = false; return json({ error: "登录已失效" }, 401); }
    if (endpoint === "/api/bootstrap") return json({ token: session.token, features: { bulkActions: true, linkedAccounts: true } });
    if (endpoint.startsWith("/api/jobs")) return json({ jobs: [], selection: [], stats: { active: 0, queued: 0, completed: 0 }, pagination: { page: 1, totalPages: 1, total: 0 } });
    if (endpoint === "/api/auto-sync") return json({ items: [], repair: { enabled: false } });
    return json({});
  };
  async function until(check) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (check()) return;
      await delay(20);
    }
    throw new Error("Auth UI condition timed out");
  }
  const button = label => [...document.querySelectorAll("button")].find(item => item.textContent.trim() === label);
  function fill(id, value) {
    const input = document.getElementById(id);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  const enterPassword = async () => { fill("console-password", "Test1234AbCd"); await delay(20); };
  try {
    dom.window.eval(await fs.readFile(path.join(assets, bundle), "utf8"));
    await until(() => button("登录控制台"));
    assert.equal(dom.window.location.pathname, "/login");
    assert.equal(document.querySelector(".console-login-footer").textContent, "登录有效期为 3 天；退出、改密或服务重启后需重新登录");
    assert.equal(calls.some(call => call.endpoint === "/api/bootstrap"), false, "protected app must not mount before authentication");
    assert.equal(document.getElementById("console-password").autocomplete, "current-password");
    fill("console-username", "");
    await delay(20);
    button("登录控制台").click();
    await until(() => document.activeElement.id === "console-username");
    assert.equal(logins, 0);
    fill("console-username", "admin");
    await enterPassword();
    document.querySelector('[aria-label="显示密码"]').click();
    await until(() => document.getElementById("console-password").type === "text");
    button("登录控制台").click();
    await until(() => document.querySelector('[role="alert"]')?.textContent.includes("账号或密码不正确"));
    assert.equal(document.getElementById("console-password").value, "");
    assert.equal(document.getElementById("console-password").type, "password");
    assert.equal(document.getElementById("console-username").value, "admin");
    mode = "limited";
    await enterPassword();
    button("登录控制台").click();
    await until(() => [...document.querySelectorAll("button")].some(item => item.disabled && item.textContent.includes("秒后重试")));
    await until(() => button("登录控制台") && !button("登录控制台").disabled);
    mode = "network";
    await enterPassword();
    button("登录控制台").click();
    await until(() => document.querySelector('[role="alert"]')?.textContent.includes("检查网络"));
    mode = "pending";
    const previousLogins = logins;
    button("登录控制台").click();
    await until(() => release && button("正在登录…")?.disabled);
    button("正在登录…").click();
    assert.equal(logins, previousLogins + 1);
    release();
    await until(() => button("退出登录") && button("批量添加任务"));
    assert.equal(dom.window.location.pathname, "/");
    assert.equal(document.getElementById("console-password"), null);
    assert.equal(Object.values(dom.window.localStorage).some(value => String(value).includes("Test1234AbCd") || String(value).includes(session.token)), false);
    logoutFailed = true;
    button("退出登录").click();
    await until(() => document.querySelector('.console-session-error')?.textContent.includes("尚未确认注销"));
    assert.ok(button("批量添加任务"));
    logoutFailed = false;
    button("退出登录").click();
    await until(() => button("登录控制台"));
    assert.match(document.querySelector('[role="status"]').textContent, /已退出/);
    assert.equal(button("批量添加任务"), undefined);
    mode = "success";
    await enterPassword();
    button("登录控制台").click();
    await until(() => button("批量添加任务"));
    expire = true;
    await until(() => button("登录控制台"));
    assert.match(document.querySelector('[role="status"]').textContent, /后台授权任务仍在运行/);
    assert.equal(document.getElementById("console-password").value, "");
    assert.equal(calls.some(call => call.endpoint.includes("delete-batch")), false, "reauthentication cannot replay destructive requests");
    console.log("PASS: compiled login UI, validation/focus, password visibility, generic errors, rate-limit countdown, network failure, duplicate-submit guard, logout failure/retry, expiry and protected app unmount");
  } finally { dom.window.close(); }
}
