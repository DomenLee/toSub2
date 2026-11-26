#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.argv[2] || 4494);
const base = `http://127.0.0.1:${port}`;
const factorId = "0123456789abcdef0123456789abcdef";
const password = "local-test-password";
const totpSecret = "JBSWY3DPEHPK3PXP";
const organizationWorkspaceId = "workspace-organization";
const personalWorkspaceId = "workspace-personal";
let chatgptWorkspaceSelected = false;
let chatgptLoginComplete = false;
let workspaceSelectionCount = 0;
let selectedEmail = "mfa-test@example.com";
let totpEnabled = false;
let passwordVerifySentinelCount = 0;
let signinConnection = "";
let signinScreenHint = "";
let oauthTokenRequests = 0;
let authSession = "";
let authQuery = "";
let passwordPageVisits = 0;
let passwordVerifyCount = 0;
let emailOtpValidationCount = 0;
let emailOtpResendCount = 0;
let authorizeContinueCount = 0;
let mfaVerificationCount = 0;
let emailChangeBeginCount = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", base);
  const body = await readBody(req);

  if (req.method === "GET" && url.pathname === "/" && url.searchParams.get("action") === "enable") {
    res.setHeader("set-cookie", [
      "__Secure-next-auth.session-token=mock-session; Path=/",
    ]);
    return sendText(res, 200, '<html><script>window.__INITIAL_STATE__={"accessToken":"mock-chatgpt-access-token-1234567890"}</script></html>', "text/html");
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.setHeader("set-cookie", [
      "__Host-next-auth.csrf-token=mock-csrf; Path=/",
      "__Secure-next-auth.session-token=mock-session; Path=/",
    ]);
    const accessToken = webAccessToken();
    return sendText(res, 200, `<html><script>{"accessToken":"${accessToken}"}</script>ok</html>`, "text/html");
  }
  if (req.method === "GET" && url.pathname === "/api/auth/providers") return sendJson(res, 200, {});
  if (req.method === "GET" && url.pathname === "/api/auth/csrf") return sendJson(res, 200, { csrfToken: "mock-csrf" });
  if (req.method === "GET" && url.pathname === "/__test/state") {
    return sendJson(res, 200, {
      chatgptLoginComplete,
      chatgptWorkspaceSelected,
      workspaceSelectionCount,
      passwordVerifySentinelCount,
      signinConnection,
      signinScreenHint,
      oauthTokenRequests,
      passwordPageVisits,
      passwordVerifyCount,
      emailOtpValidationCount,
      emailOtpResendCount,
      authorizeContinueCount,
      mfaVerificationCount,
      emailChangeBeginCount,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/signin/openai") {
    chatgptWorkspaceSelected = false;
    chatgptLoginComplete = false;
    signinConnection = url.searchParams.get("connection") || "";
    signinScreenHint = url.searchParams.get("screen_hint") || "";
    selectedEmail = url.searchParams.get("login_hint") || selectedEmail;
    passwordPageVisits = 0;
    passwordVerifyCount = 0;
    emailOtpValidationCount = 0;
    emailOtpResendCount = 0;
    authorizeContinueCount = 0;
    mfaVerificationCount = 0;
    emailChangeBeginCount = 0;
    authSession = crypto.randomUUID();
    authQuery = new URLSearchParams({ auth_page: `mock+context/${authSession}=`, state: "mock-state" }).toString();
    const passwordMode = selectedEmail !== "email-mfa@example.com" && !selectedEmail.startsWith("switch-");
    return sendJson(res, 200, { url: `${base}/api/accounts/authorize?mode=${passwordMode ? "password" : "email"}` });
  }
  if (req.method === "GET" && url.pathname === "/api/accounts/authorize") {
    res.setHeader("set-cookie", `auth-flow=${authSession}; Path=/; HttpOnly`);
    return redirect(res, `${base}${url.searchParams.get("mode") === "email" ? "/email-verification" : "/log-in/password"}?${authQuery}`);
  }
  if (req.method === "GET" && ["/log-in/password", "/email-verification"].includes(url.pathname)) {
    if (url.pathname === "/log-in/password") {
      passwordPageVisits += 1;
      if (selectedEmail.startsWith("switch-")) {
        if (!hasAuthContext(req, url) || req.headers.referer !== `${base}/email-verification?${authQuery}`) {
          return sendJson(res, 400, { error: { message: "password switch lost the original auth context" } });
        }
        if (selectedEmail === "switch-unavailable@example.com") return redirect(res, `${base}/email-verification?${authQuery}`);
      }
    }
    return sendText(res, 200, `<html><title>${url.pathname === "/log-in/password" ? "Enter password" : "Check inbox"}</title></html>`, "text/html");
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/authorize/continue") {
    authorizeContinueCount += 1;
    return sendJson(res, 404, { error: { message: "password switching uses page navigation" } });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/passwordless/send-otp") {
    emailOtpResendCount += 1;
    return sendJson(res, 200, {});
  }
  if (req.method === "POST" && url.pathname === "/backend-api/sentinel/req") {
    const payload = parseJson(body);
    if (payload.flow !== "password_verify" || typeof payload.id !== "string" || !payload.id) {
      return sendJson(res, 400, { error: { message: "invalid sentinel request" } });
    }
    passwordVerifySentinelCount += 1;
    return sendJson(res, 200, {
      token: "mock-password-verify-challenge",
      proofofwork: { required: false },
      turnstile: { required: false },
    });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/password/verify") {
    passwordVerifyCount += 1;
    if (selectedEmail.startsWith("switch-") && (passwordPageVisits !== 1 || !hasAuthContext(req, new URL(req.headers.referer || "/", base)))) {
      return sendJson(res, 400, { error: { message: "password verification lost the original auth context" } });
    }
    const payload = parseJson(body);
    if (!hasPasswordVerifySentinel(req) || payload.password !== password || Object.keys(payload).length !== 1) {
      return sendJson(res, 401, { error: { message: "invalid password" } });
    }
    if (selectedEmail === "setup-totp@example.com") return sendJson(res, 200, { continue_url: `${base}/web-callback`, page: { type: "external_url" } });
    return sendJson(res, 200, mfaPayload());
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/email-otp/validate") {
    emailOtpValidationCount += 1;
    const payload = parseJson(body);
    if (payload.code !== "123456" || Object.keys(payload).length !== 1) {
      return sendJson(res, 400, { error: { message: "invalid email code" } });
    }
    return sendJson(res, 200, mfaPayload());
  }
  if (req.method === "GET" && url.pathname === "/backend-api/accounts/mfa_info") {
    if (selectedEmail === "setup-totp@example.com" && totpEnabled) {
      return sendJson(res, 503, { error: { message: "simulated confirmation failure" } });
    }
    return sendJson(res, 200, {
      mfa_enabled: totpEnabled,
      mfa_enabled_v2: totpEnabled,
      factors: { totp: totpEnabled ? [{ id: "setup-factor", factor_type: "totp" }] : [], push_auth: null, passkeys: [], sms: [] },
    });
  }
  if (req.method === "POST" && url.pathname === "/backend-api/accounts/mfa/enroll") {
    if (selectedEmail !== "setup-totp@example.com" || totpEnabled) return sendJson(res, 409, { error: { message: "already enabled" } });
    return sendJson(res, 200, {
      secret: "NB2W45DFOIZAQWER",
      session_id: "mock-enroll-session",
      factor: { id: "setup-factor", factor_type: "totp", is_recovery: false },
    });
  }
  if (req.method === "POST" && url.pathname === "/backend-api/accounts/mfa/user/activate_enrollment") {
    const payload = parseJson(body);
    const acceptedCodes = [-1, 0, 1].map((offset) => generateTotp("NB2W45DFOIZAQWER", Date.now() + offset * 30_000));
    if (!acceptedCodes.includes(payload.code) || payload.factor_type !== "totp" || payload.session_id !== "mock-enroll-session") {
      return sendJson(res, 400, { error: { message: "invalid setup code" } });
    }
    totpEnabled = true;
    return sendJson(res, 200, { success: true });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/mfa/issue_challenge") {
    const payload = parseJson(body);
    if (payload.type !== "totp" || payload.id !== factorId || payload.force_fresh_challenge !== false) {
      return sendJson(res, 400, { error: { message: "invalid challenge request" } });
    }
    return sendJson(res, 200, { "oai-client-auth-session": mfaSession() });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/mfa/verify") {
    mfaVerificationCount += 1;
    const payload = parseJson(body);
    const acceptedCodes = [-1, 0, 1].map((offset) => generateTotp(totpSecret, Date.now() + offset * 30_000));
    if (!hasPasswordVerifySentinel(req) || payload.type !== "totp" || payload.id !== factorId || !acceptedCodes.includes(payload.code)) {
      return sendJson(res, 400, { error: { message: "invalid totp" } });
    }
    if (selectedEmail === "skip-workspace@example.com") {
      return sendJson(res, 200, { continue_url: `${base}/web-callback`, page: { type: "workspace" } });
    }
    return sendJson(res, 200, {
      continue_url: `${base}/workspace`,
      page: { type: "workspace" },
      "oai-client-auth-session": {
        workspaces: [
          { id: organizationWorkspaceId, kind: "organization" },
          { id: personalWorkspaceId, kind: "personal" },
        ],
      },
    });
  }
  if (req.method === "GET" && url.pathname === "/workspace") {
    return sendText(res, 200, "<html><title>Select workspace</title></html>", "text/html");
  }
  if (req.method === "GET" && url.pathname === "/web-callback") {
    chatgptLoginComplete = true;
    return redirect(res, `${base}/`);
  }
  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    return redirect(res, `${base}${chatgptLoginComplete ? "/choose-an-account" : "/log-in"}`);
  }
  if (req.method === "GET" && url.pathname === "/log-in") {
    return sendText(res, 200, "<html><title>Log in</title></html>", "text/html");
  }
  if (req.method === "GET" && url.pathname === "/choose-an-account") {
    return sendText(res, 200, '<html><input name="session_id" value="us_1234567890abcdef"></html>', "text/html");
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/session/select") {
    if (selectedEmail === "direct-codex-callback@example.com") {
      return sendJson(res, 200, {
        continue_url: "http://localhost:1455/auth/callback?code=mock-code&state=mock-state",
        page: { type: "external_url" },
      });
    }
    return sendJson(res, 200, {
      "oai-client-auth-session": {
        workspaces: [
          { id: personalWorkspaceId, kind: "personal" },
          { id: organizationWorkspaceId, kind: "organization" },
        ],
      },
    });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/workspace/select") {
    const payload = parseJson(body);
    if (!chatgptWorkspaceSelected && selectedEmail !== "skip-workspace@example.com") {
      if (payload.workspace_id !== organizationWorkspaceId) {
        return sendJson(res, 400, { error: { message: "unexpected ChatGPT workspace" } });
      }
      chatgptWorkspaceSelected = true;
      workspaceSelectionCount += 1;
      return sendJson(res, 200, { continue_url: `${base}/web-callback`, page: { type: "external_url" } });
    }
    if (payload.workspace_id !== organizationWorkspaceId) {
      return sendJson(res, 400, { error: { message: "unexpected Codex workspace" } });
    }
    workspaceSelectionCount += 1;
    return sendJson(res, 200, { continue_url: "http://localhost:1455/auth/callback?code=mock-code&state=mock-state" });
  }
  if (req.method === "GET" && url.pathname === "/backend-api/accounts/change_email/eligibility") {
    return sendJson(res, 200, { eligible: true });
  }
  if (req.method === "POST" && url.pathname === "/backend-api/accounts/change_email/begin") {
    emailChangeBeginCount += 1;
    if (!chatgptLoginComplete || mfaVerificationCount !== 1) return sendJson(res, 401, { error: { message: "web login and 2FA required" } });
    return sendJson(res, 200, { success: true });
  }
  if (req.method === "POST" && url.pathname === "/backend-api/accounts/change_email/verify") {
    return sendJson(res, 200, { success: true });
  }
  if (req.method === "GET" && url.pathname === "/mail-code") {
    return sendJson(res, 200, { code: "654321", id: "fresh", received_at: new Date().toISOString() });
  }
  if (req.method === "POST" && url.pathname === "/oauth/token") {
    oauthTokenRequests += 1;
    const idTokenPayload = Buffer.from(JSON.stringify({
      email: selectedEmail,
      sid: "mock-account-id",
      sub: "mock-user-id",
    })).toString("base64url");
    return sendJson(res, 200, {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      id_token: `e30.${idTokenPayload}.signature`,
    });
  }
  return sendJson(res, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => console.log(`[ok] Mock password/MFA server: ${base}`));

function webAccessToken() {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_workspace" },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function mfaPayload() {
  return {
    continue_url: `${base}/mfa-challenge/${factorId}`,
    page: { type: "mfa_challenge" },
    "oai-client-auth-session": mfaSession(),
  };
}

function mfaSession() {
  if (selectedEmail === "skip-workspace@example.com") {
    return {
      mfa_factors: [{ factor_type: "totp", id: factorId, metadata: {} }],
      mfa_challenge_factors: [{ factor_type: "totp", id: factorId, metadata: {} }],
    };
  }
  return {
    mfa_factors: [{ factor_type: "totp", id: factorId, metadata: {} }],
    mfa_challenge_factors: [{ factor_type: "totp", id: factorId, metadata: {} }],
    workspaces: [
      { id: organizationWorkspaceId, kind: "organization" },
      { id: personalWorkspaceId, kind: "personal" },
    ],
  };
}

function generateTotp(secret, timestamp) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30_000)));
  const digest = crypto.createHmac("sha1", key).update(counter).digest();
  const offset = digest.at(-1) & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(number % 1_000_000).padStart(6, "0");
}

function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function hasAuthContext(req, url) {
  return (req.headers.cookie || "").split("; ").includes(`auth-flow=${authSession}`)
    && url.search === `?${authQuery}`;
}

function hasPasswordVerifySentinel(req) {
  const sentinel = parseJson(req.headers["openai-sentinel-token"]);
  return sentinel.flow === "password_verify"
    && sentinel.c === "mock-password-verify-challenge"
    && typeof sentinel.id === "string"
    && Boolean(sentinel.id);
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, contentType = "text/plain") {
  res.writeHead(status, { "content-type": contentType });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
