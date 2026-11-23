import crypto from "node:crypto";
import {
  fetchMailboxOtpCandidates,
  validateMailApiUrl,
} from "./mail-otp.mjs";

export const CHANGE_EMAIL_PATHS = {
  eligibility: "/backend-api/accounts/change_email/eligibility",
  mfaInfo: "/backend-api/accounts/mfa_info",
  begin: "/backend-api/accounts/change_email/begin",
  verify: "/backend-api/accounts/change_email/verify",
};

const OTP_TIMESTAMP_SKEW_MS = 5_000;
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isMailboxAddress(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 254 || /\s/.test(text)) return false;
  const at = text.lastIndexOf("@");
  if (at <= 0 || at !== text.indexOf("@")) return false;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => (
    !label
    || label.length > 63
    || label.startsWith("-")
    || label.endsWith("-")
    || !/^[A-Z0-9-]+$/i.test(label)
  ))) return false;
  return /^(?:[A-Z]{2,63}|XN--[A-Z0-9-]{2,59})$/i.test(labels.at(-1));
}

export function accountIdFromAccessToken(token) {
  const raw = String(token || "").replace(/^Bearer\s+/i, "").trim();
  const segment = raw.split(".")[1] || "";
  if (!segment) return "";
  try {
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    const auth = payload?.["https://api.openai.com/auth"];
    const id = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id.trim() : "";
    if (!id || id.startsWith("authsess_")) return "";
    return id;
  } catch {
    return "";
  }
}

export function extractAccessToken(value) {
  const text = String(value || "");
  const sources = [text, text.replace(/&quot;/g, '"').replace(/&#34;/g, '"')];
  for (const source of sources) {
    const match = /["']accessToken["']\s*:\s*"((?:\\.|[^"\\])+)"/.exec(source);
    if (!match) continue;
    try {
      const token = JSON.parse(`"${match[1]}"`);
      if (typeof token === "string" && token.length >= 20) return token;
    } catch {}
  }
  return "";
}

export function buildChangeEmailHeaders({ accessToken, accountId, deviceId, sessionId, targetPath }) {
  const token = String(accessToken || "").trim();
  return {
    accept: "*/*",
    authorization: token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    "oai-device-id": deviceId,
    "oai-language": "zh-CN",
    "oai-session-id": sessionId,
    "x-openai-target-path": targetPath,
    "x-openai-target-route": targetPath,
  };
}

export function classifyChangeEmailPayload(status, payload) {
  const markers = [];
  const visit = (value, depth = 0) => {
    if (depth > 4 || markers.length >= 40) return;
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => {
        markers.push(String(key).toLowerCase());
        visit(item, depth + 1);
      });
      return;
    }
    if (["string", "number", "boolean"].includes(typeof value)) markers.push(String(value).toLowerCase());
  };
  visit(payload);
  const text = markers.join(" ");
  if (text.includes("email_already_linked") || text.includes("already linked") || text.includes("already_linked")) {
    return "email_already_linked";
  }
  if (
    status === 401
    || text.includes("reauth_required")
    || text.includes("recent authentication")
    || text.includes("recent_authentication")
  ) {
    return "reauth_required";
  }
  return "";
}

export function emailChangeStatusText(status) {
  return {
    same_email: "新邮箱与当前邮箱相同",
    missing_session: "登录会话缺少换绑所需的工作区标识",
    not_eligible: "当前账号暂时不能换绑邮箱",
    eligibility_unconfirmed: "未能确认换绑资格",
    eligibility_http_error: "换绑资格检查失败",
    mfa_http_error: "账号验证信息读取失败",
    email_already_linked: "新邮箱已被其他账号占用",
    begin_http_error: "开始换绑失败",
    begin_rejected: "开始换绑被拒绝",
    otp_timeout: "新邮箱验证码等待超时，请确认取码地址后重试",
    verify_http_error: "换绑验证请求失败",
    verify_rejected: "新邮箱验证码未通过",
    reauth_required: "网页登录状态已失效，请重试",
    exception: "换绑过程出现异常",
  }[status] || "换绑未完成";
}

function missingSessionFields(session) {
  return [
    ["accessToken", "access_token"],
    ["accountId", "account_id"],
    ["deviceId", "device_id"],
  ].filter(([key]) => !String(session?.[key] || "").trim()).map(([, label]) => label);
}

function isTransientFailure(error, status) {
  if (TRANSIENT_STATUS.has(status)) return true;
  const text = String(error?.message || error || "").toLowerCase();
  return ["timeout", "timed out", "econnreset", "econnrefused", "socket", "network", "fetch failed", "aborted"].some((marker) => text.includes(marker));
}

async function requestWithRetry(request, method, path, body, sleep) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await request(method, path, body);
      if (!isTransientFailure(null, response?.status) || attempt >= 2) return response;
    } catch (error) {
      lastError = error;
      if (!isTransientFailure(error) || attempt >= 2) throw error;
    }
    await sleep([1500, 3000, 5000][attempt]);
  }
  throw lastError || new Error("account_request_no_response");
}

export async function waitForMailboxOtp({
  url,
  request = {},
  notBefore = 0,
  baselineKeys = [],
  requireTimestamp = false,
  timeoutMs = 180_000,
  intervalMs = 2_500,
  fetchImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  if (!validateMailApiUrl(url)) {
    const error = new Error("otp_url_invalid");
    error.code = "otp_timeout";
    throw error;
  }
  const seen = new Set(baselineKeys);
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    try {
      const candidates = await fetchMailboxOtpCandidates(url, {
        request,
        fetchImpl,
        timeoutMs: Math.min(60_000, Math.max(1_000, deadline - now())),
      });
      const timed = candidates.find((candidate) => (
        candidate.receivedAt
        && candidate.receivedAt + OTP_TIMESTAMP_SKEW_MS >= notBefore
      ));
      if (timed?.code) return timed.code;
      if (!requireTimestamp) {
        const unseen = candidates.find((candidate) => !candidate.receivedAt && candidate.code && !seen.has(candidate.key));
        if (unseen) return unseen.code;
      }
    } catch {
      // Keep polling until the deadline. The mailbox URL and response body stay out of the error.
    }
    if (now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  const error = new Error("otp_timeout");
  error.code = "otp_timeout";
  throw error;
}

export async function runChangeEmail({
  oldEmail,
  newEmail,
  session,
  request,
  fetchOtp,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const source = String(oldEmail || "").trim();
  const replacement = String(newEmail || "").trim();
  if (!isMailboxAddress(source) || !isMailboxAddress(replacement)) return { ok: false, status: "same_email" };
  if (source.toLowerCase() === replacement.toLowerCase()) return { ok: false, status: "same_email" };
  const missing = missingSessionFields(session);
  if (missing.length) return { ok: false, status: "missing_session", missing };
  const sessionState = {
    accessToken: String(session.accessToken).trim(),
    accountId: String(session.accountId).trim(),
    deviceId: String(session.deviceId).trim(),
    sessionId: String(session.sessionId || crypto.randomUUID()).trim(),
  };

  const call = (method, targetPath, body) => requestWithRetry(
    (nextMethod, nextPath, nextBody) => request(nextMethod, nextPath, nextBody, sessionState),
    method,
    targetPath,
    body,
    sleep,
  );

  try {
    const eligibility = await call("GET", CHANGE_EMAIL_PATHS.eligibility);
    const eligibilityCode = classifyChangeEmailPayload(eligibility?.status, eligibility?.payload);
    if (eligibilityCode === "reauth_required") return { ok: false, status: "reauth_required" };
    if (!(eligibility?.status >= 200 && eligibility?.status < 300)) {
      return { ok: false, status: eligibilityCode || "eligibility_http_error" };
    }
    if (eligibility?.payload?.eligible !== true) {
      return {
        ok: false,
        status: eligibility?.payload?.eligible === false ? "not_eligible" : "eligibility_unconfirmed",
      };
    }

    const mfaInfo = await call("GET", CHANGE_EMAIL_PATHS.mfaInfo);
    const mfaCode = classifyChangeEmailPayload(mfaInfo?.status, mfaInfo?.payload);
    if (mfaCode === "reauth_required") return { ok: false, status: "reauth_required" };
    if (!(mfaInfo?.status >= 200 && mfaInfo?.status < 300)) return { ok: false, status: mfaCode || "mfa_http_error" };

    const begun = await call("POST", CHANGE_EMAIL_PATHS.begin, { email: replacement });
    const beginCode = classifyChangeEmailPayload(begun?.status, begun?.payload);
    if (beginCode === "reauth_required") return { ok: false, status: "reauth_required" };
    if (!(begun?.status >= 200 && begun?.status < 300)) {
      return { ok: false, status: beginCode || "begin_http_error" };
    }
    if (begun?.payload?.success !== true) return { ok: false, status: beginCode || "begin_rejected" };

    let code = "";
    try {
      code = await fetchOtp();
    } catch (error) {
      return { ok: false, status: error?.code === "otp_timeout" ? "otp_timeout" : "exception" };
    }
    if (!/^\d{6}$/.test(String(code || ""))) return { ok: false, status: "otp_timeout" };

    const verified = await call("POST", CHANGE_EMAIL_PATHS.verify, { email: replacement, code });
    const verifyCode = classifyChangeEmailPayload(verified?.status, verified?.payload);
    if (!(verified?.status >= 200 && verified?.status < 300)) {
      return { ok: false, status: verifyCode === "email_already_linked" ? verifyCode : (verifyCode || "verify_http_error") };
    }
    if (verified?.payload?.success !== true) return { ok: false, status: "verify_rejected" };
    return { ok: true, status: "changed" };
  } catch {
    return { ok: false, status: "exception" };
  }
}
