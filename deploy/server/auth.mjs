import crypto from "node:crypto";
import fs from "node:fs/promises";

const cookieName = "__Host-tosub2-session";
const lifetime = 3 * 24 * 60 * 60_000;
const idle = lifetime;
const hash = value => crypto.createHash("sha256").update(value).digest();
const equal = (left, right) => crypto.timingSafeEqual(hash(String(left)), hash(String(right)));
const asset = pathname => pathname === "/favicon.svg" || /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|svg|png|woff2?)$/.test(pathname);

async function readLogin(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw new Error("invalid login body");
  if (Number(req.headers["content-length"]) > 4096) throw new Error("invalid login body");
  const chunks = [];
  let length = 0;
  const timer = setTimeout(() => req.destroy(), 5000);
  try {
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 4096) throw new Error("invalid login body");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof body?.username !== "string" || typeof body.password !== "string" || body.username.length > 128 || body.password.length > 512) throw new Error("invalid login body");
    return body;
  } finally { clearTimeout(timer); }
}

export async function createAuth({ passwordFile = process.env.CONSOLE_PASSWORD_FILE || "/run/secrets/console-password", origin = process.env.PUBLIC_ORIGIN, now = Date.now } = {}) {
  if (!origin || new URL(origin).origin !== origin || !origin.startsWith("https://")) throw new Error("PUBLIC_ORIGIN must be an HTTPS origin");
  const sessions = new Map();
  const attempts = new Map();
  let expected;
  let windowStart = now();
  let totalAttempts = 0;
  async function refreshPassword() {
    const password = (await fs.readFile(passwordFile, "utf8")).trim();
    if (password.length < 12 || password.length > 512) throw new Error("Console password must contain 12 to 512 characters");
    const next = hash(`admin\0${password}`);
    if (expected && !crypto.timingSafeEqual(expected, next)) sessions.clear();
    expected = next;
  }
  await refreshPassword();

  function json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
    return false;
  }
  function setCookie(res, value, maxAge = lifetime / 1000) {
    res.setHeader("Set-Cookie", `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
  }
  function sessionInfo(session) {
    return { username: "admin", token: session.token, expiresIn: Math.max(0, Math.min(session.created + lifetime, session.active + idle) - now()) };
  }
  function collect() {
    for (const [key, session] of sessions) if (now() >= Math.min(session.created + lifetime, session.active + idle)) sessions.delete(key);
    for (const [key, attempt] of attempts) if (now() - attempt.updated >= 5 * 60_000) attempts.delete(key);
  }

  return async function authorize(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const pathname = new URL(req.url || "/", origin).pathname;
    const read = ["GET", "HEAD"].includes(req.method);
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: "请求来源不受信任，请从控制台页面重试。" });
    if (read && pathname === "/healthz") return json(res, 200, { status: "ok" });
    if (read && (pathname === "/login" || asset(pathname))) return true;
    try { await refreshPassword(); }
    catch { return json(res, 503, { error: "登录服务暂不可用，请管理员检查访问凭据配置后重试。" }); }
    collect();
    const cookies = String(req.headers.cookie || "").split(";").map(value => value.trim()).filter(value => value.startsWith(cookieName + "="));
    const raw = cookies.length === 1 ? cookies[0].slice(cookieName.length + 1) : "";
    const sessionKey = /^[a-zA-Z0-9_-]{43}$/.test(raw) ? hash(raw).toString("hex") : "";
    const session = sessions.get(sessionKey);
    if (pathname === "/api/auth/login" && req.method === "POST") {
      if (req.headers.origin !== origin) return json(res, 403, { error: "请从登录页面提交账号和密码。" });
      const address = req.socket.remoteAddress || "unknown";
      if (now() - windowStart >= 60_000) { windowStart = now(); totalAttempts = 0; }
      const attempt = attempts.get(address);
      const remaining = Math.max(0, Math.ceil(((attempt?.until || 0) - now()) / 1000));
      if (remaining || totalAttempts >= 120 || (!attempt && attempts.size >= 2048)) {
        const retryAfter = remaining || 60;
        res.setHeader("Retry-After", String(retryAfter));
        return json(res, 429, { error: "登录尝试过于频繁，请稍后重试。", retryAfter });
      }
      totalAttempts++;
      let body;
      try { body = await readLogin(req); }
      catch { return json(res, 400, { error: "登录信息格式不正确，请重新输入账号和密码。" }); }
      if (!crypto.timingSafeEqual(expected, hash(`${body.username.trim()}\0${body.password}`))) {
        const latest = attempts.get(address);
        const count = (latest?.until && now() >= latest.until ? 0 : latest?.count || 0) + 1;
        attempts.set(address, { count, updated: now(), until: count >= 5 ? now() + 60_000 : 0 });
        if (count >= 5) {
          res.setHeader("Retry-After", "60");
          return json(res, 429, { error: "登录尝试过于频繁，请稍后重试。", retryAfter: 60 });
        }
        return json(res, 401, { error: "账号或密码不正确，请检查后重试。" });
      }
      attempts.delete(address);
      if (sessionKey) sessions.delete(sessionKey);
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
      const value = crypto.randomBytes(32).toString("base64url");
      const next = { token: crypto.randomBytes(32).toString("base64url"), created: now(), active: now() };
      sessions.set(hash(value).toString("hex"), next);
      setCookie(res, value);
      return json(res, 200, sessionInfo(next));
    }
    if (!session) {
      setCookie(res, "", 0);
      if (read && !pathname.startsWith("/api/")) {
        res.writeHead(302, { Location: "/login" });
        res.end();
        return false;
      }
      return json(res, 401, { code: "session_expired", error: "登录已失效，请重新登录；后台授权任务不受影响。" });
    }
    if (!read && (req.headers.origin !== origin || !equal(req.headers["x-console-token"] || "", session.token))) return json(res, 403, { error: "请求校验失败，请刷新页面后重新操作。" });
    if (pathname === "/api/auth/session" && req.method === "GET") return json(res, 200, sessionInfo(session));
    if (pathname === "/api/auth/activity" && req.method === "POST") {
      session.active = now();
      return json(res, 200, sessionInfo(session));
    }
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      sessions.delete(sessionKey);
      setCookie(res, "", 0);
      return json(res, 200, { loggedOut: true });
    }
    if (pathname.startsWith("/api/auth/")) return json(res, 404, { error: "登录接口不存在。" });
    req.consoleSession = session;
    return true;
  };
}
