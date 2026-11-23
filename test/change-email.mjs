import assert from "node:assert/strict";
import {
  accountIdFromAccessToken,
  buildChangeEmailHeaders,
  classifyChangeEmailPayload,
  emailChangeStatusText,
  runChangeEmail,
  waitForMailboxOtp,
} from "../src/change-email.mjs";

function token(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const accountToken = token({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_workspace" },
});
assert.equal(accountIdFromAccessToken(accountToken), "acct_workspace");
assert.equal(accountIdFromAccessToken(token({
  "https://api.openai.com/auth": { chatgpt_account_id: "authsess_old" },
})), "");
assert.equal(accountIdFromAccessToken(token({ sid: "sess_123" })), "");

const headers = buildChangeEmailHeaders({
  accessToken: accountToken,
  accountId: "acct_workspace",
  deviceId: "device-1",
  sessionId: "session-1",
  targetPath: "/backend-api/accounts/change_email/begin",
});
assert.equal(headers.authorization, `Bearer ${accountToken}`);
assert.equal(headers["chatgpt-account-id"], "acct_workspace");
assert.equal(headers["oai-device-id"], "device-1");
assert.equal(classifyChangeEmailPayload(400, { detail: { code: "email_already_linked" } }), "email_already_linked");
assert.equal(classifyChangeEmailPayload(401, { error: "reauth_required" }), "reauth_required");
assert.match(emailChangeStatusText("email_already_linked"), /占用/);

const calls = [];
const changed = await runChangeEmail({
  oldEmail: "old@example.com",
  newEmail: "new@example.com",
  session: { accessToken: accountToken, accountId: "acct_workspace", deviceId: "device-1" },
  sleep: async () => {},
  fetchOtp: async () => "123456",
  request: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith("/eligibility")) return { status: 200, payload: { eligible: true } };
    if (path.endsWith("/mfa_info")) return { status: 200, payload: { mfa_enabled_v2: false } };
    if (path.endsWith("/begin")) return { status: 200, payload: { success: true } };
    if (path.endsWith("/verify")) return { status: 200, payload: { success: true } };
    throw new Error(`unexpected ${path}`);
  },
});
assert.equal(changed.ok, true);
assert.equal(changed.status, "changed");
assert.deepEqual(calls.map((call) => [call.method, call.path.split("/").at(-1)]), [
  ["GET", "eligibility"],
  ["GET", "mfa_info"],
  ["POST", "begin"],
  ["POST", "verify"],
]);
assert.deepEqual(calls[2].body, { email: "new@example.com" });
assert.deepEqual(calls[3].body, { email: "new@example.com", code: "123456" });
assert.equal(JSON.stringify(changed).includes("123456"), false);

const occupied = await runChangeEmail({
  oldEmail: "old@example.com",
  newEmail: "used@example.com",
  session: { accessToken: accountToken, accountId: "acct_workspace", deviceId: "device-1" },
  sleep: async () => {},
  fetchOtp: async () => { throw new Error("should not fetch"); },
  request: async (method, path) => {
    if (path.endsWith("/eligibility")) return { status: 200, payload: { eligible: true } };
    if (path.endsWith("/mfa_info")) return { status: 200, payload: {} };
    return { status: 400, payload: { detail: "email_already_linked" } };
  },
});
assert.equal(occupied.status, "email_already_linked");
assert.equal(occupied.ok, false);

const same = await runChangeEmail({
  oldEmail: "same@example.com",
  newEmail: "Same@example.com",
  session: { accessToken: accountToken, accountId: "acct_workspace", deviceId: "device-1" },
  request: async () => { throw new Error("network"); },
});
assert.equal(same.status, "same_email");

let verifyCalls = 0;
const expired = await runChangeEmail({
  oldEmail: "old@example.com",
  newEmail: "new@example.com",
  session: { accessToken: accountToken, accountId: "acct_workspace", deviceId: "device-1" },
  sleep: async () => {},
  fetchOtp: async () => "654321",
  request: async (method, path) => {
    if (path.endsWith("/verify")) {
      verifyCalls += 1;
      return { status: 401, payload: { error: "reauth_required" } };
    }
    if (path.endsWith("/eligibility")) return { status: 200, payload: { eligible: true } };
    if (path.endsWith("/mfa_info")) return { status: 200, payload: {} };
    return { status: 200, payload: { success: true } };
  },
});
assert.equal(expired.status, "reauth_required");
assert.equal(verifyCalls, 1);

const notBefore = Date.parse("2026-01-01T00:00:10.000Z");
let now = notBefore;
const code = await waitForMailboxOtp({
  url: "https://mail.example/latest",
  notBefore,
  baselineKeys: ["old"],
  timeoutMs: 5_000,
  intervalMs: 10,
  now: () => now,
  sleep: async () => { now += 10; },
  fetchImpl: async () => new Response(JSON.stringify({ messages: [
    { code: "111111", id: "old-message", received_at: "2026-01-01T00:00:01.000Z" },
    { code: "222222", id: "new-message", received_at: "2026-01-01T00:00:20.000Z" },
  ] }), { status: 200, headers: { "content-type": "application/json" } }),
});
assert.equal(code, "222222");

let clock = 0;
await assert.rejects(waitForMailboxOtp({
  url: "https://mail.example/latest",
  notBefore: 5_000,
  requireTimestamp: true,
  timeoutMs: 50,
  intervalMs: 10,
  now: () => clock,
  sleep: async () => { clock += 100; },
  fetchImpl: async () => new Response(JSON.stringify({ code: "333333" }), { status: 200, headers: { "content-type": "application/json" } }),
}), (error) => error.code === "otp_timeout");

console.log("PASS: change email protocol");
