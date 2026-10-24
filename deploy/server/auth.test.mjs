import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAuth } from "./auth.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-auth-"));
const passwordFile = path.join(directory, "password");
const origin = "https://console.example.invalid";
let password = "Test1234AbCd";
await fs.writeFile(passwordFile, password, { mode: 0o600 });
let time = 100000;
const settings = { passwordFile, origin, now: () => time };
let authorize = await createAuth(settings);
const server = http.createServer(async (req, res) => {
  if (!await authorize(req, res)) return;
  if (req.url === "/login") { res.end("LOGIN_ONLY"); return; }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ protected: true, token: req.consoleSession?.token }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function login(overrides = {}, headers = {}) {
  return fetch(base + "/api/auth/login", { method: "POST", headers: { Origin: origin, "content-type": "application/json", ...headers }, body: JSON.stringify({ username: "admin", password, ...overrides }) });
}
async function session() {
  const response = await login();
  assert.equal(response.status, 200);
  const data = await response.json();
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^__Host-tosub2-session=[\w-]{43};/);
  for (const flag of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]) assert.ok(cookie.includes(flag));
  assert.ok(!cookie.includes("Domain="));
  return { headers: { Cookie: cookie.split(";")[0], Origin: origin, "x-console-token": data.token }, data };
}
try {
  const anonymous = await fetch(base + "/api/bootstrap");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("www-authenticate"), null);
  assert.equal(anonymous.headers.get("cache-control"), "no-store");
  assert.match(anonymous.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await fetch(base, { redirect: "manual" })).headers.get("location"), "/login");
  assert.equal(await (await fetch(base + "/login")).text(), "LOGIN_ONLY");
  assert.deepEqual(await (await fetch(base + "/healthz")).json(), { status: "ok" });
  for (const endpoint of ["/api/jobs", "/api/jobs/a/download", "/api/auto-sync", "/api/linked-accounts"]) assert.equal((await fetch(base + endpoint)).status, 401);
  assert.equal((await fetch(base + "/api/bootstrap", { headers: { Authorization: "Basic " + Buffer.from("admin:" + password).toString("base64") } })).status, 401);
  assert.equal((await login({}, { Origin: "https://evil.invalid" })).status, 403);
  assert.equal((await login({}, { Origin: "" })).status, 403);
  assert.equal((await login({}, { "content-type": "text/plain" })).status, 400);
  const wrong = await login({ password: "wrong" });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, (await (await login({ username: "unknown", password: "wrong" })).json()).error);
  for (let index = 0; index < 3; index++) await login({ password: "wrong" }, { "x-forwarded-for": `192.0.2.${index}` });
  const limited = await login();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  time += 60001;
  const first = await session();
  const second = await session();
  assert.notEqual(first.data.token, second.data.token);
  const rotated = await login({}, first.headers);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.headers.get("set-cookie").split(";")[0], first.headers.Cookie);
  assert.equal((await fetch(base + "/api/bootstrap", { headers: first.headers })).status, 401);
  const valid = second.headers;
  assert.equal((await fetch(base + "/api/jobs/a/download", { headers: valid })).status, 200);
  assert.equal((await fetch(base + "/api/jobs/delete-batch", { method: "POST", headers: { Cookie: valid.Cookie, Origin: origin } })).status, 403);
  assert.equal((await fetch(base + "/api/jobs/delete-batch", { method: "POST", headers: { ...valid, "x-console-token": first.data.token } })).status, 403);
  assert.equal((await fetch(base + "/api/jobs/delete-batch", { method: "POST", headers: { ...valid, Origin: "https://sibling.example.invalid" } })).status, 403);
  assert.equal((await fetch(base + "/api/jobs/delete-batch", { method: "POST", headers: valid })).status, 200);
  time += 29 * 60000;
  assert.equal((await fetch(base + "/api/auth/session", { headers: valid })).status, 200);
  time += 60001;
  assert.equal((await fetch(base + "/api/auth/session", { headers: valid })).status, 401, "polls cannot renew idle expiry");
  const active = await session();
  time += 20 * 60000;
  assert.equal((await fetch(base + "/api/auth/activity", { method: "POST", headers: active.headers })).status, 200);
  time += 20 * 60000;
  assert.equal((await fetch(base + "/api/auth/session", { headers: active.headers })).status, 200);
  const loggedOut = await fetch(base + "/api/auth/logout", { method: "POST", headers: active.headers });
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await fetch(base + "/api/bootstrap", { headers: active.headers })).status, 401);
  const long = await session();
  for (let index = 0; index < 35; index++) {
    time += 20 * 60000;
    assert.equal((await fetch(base + "/api/auth/activity", { method: "POST", headers: long.headers })).status, 200);
  }
  time += 20 * 60000;
  assert.equal((await fetch(base + "/api/auth/activity", { method: "POST", headers: long.headers })).status, 401, "absolute expiry cannot be renewed");
  const beforeRotation = await session();
  password = "Other123AbCd";
  await fs.writeFile(passwordFile, password);
  assert.equal((await fetch(base + "/api/bootstrap", { headers: beforeRotation.headers })).status, 401, "password rotation revokes existing sessions");
  const beforeRestart = await session();
  authorize = await createAuth(settings);
  assert.equal((await fetch(base + "/api/bootstrap", { headers: beforeRestart.headers })).status, 401);
  const concurrent = await Promise.all(Array.from({ length: 10 }, () => login({ password: "wrong" })));
  assert.ok(concurrent.filter(response => response.status === 401).length <= 4, "parallel login requests cannot bypass the failure threshold");
  await fs.writeFile(passwordFile, "short");
  assert.equal((await fetch(base + "/api/auth/session", { headers: beforeRestart.headers })).status, 503);
  await assert.rejects(createAuth(settings), /12 to 512/);
  console.log("PASS: 12-character password, cookie sessions, protected APIs/downloads, no Basic bypass, CSRF/origin checks, non-spoofable rate limits, idle/absolute expiry, logout, rotation and restart revocation");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
