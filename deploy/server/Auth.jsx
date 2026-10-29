import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { ArrowRight, Eye, EyeOff, KeyRound, LoaderCircle, LogOut } from "lucide-react";
import { beginSession, endSession } from "./session.js";
import "./Auth.css";

const AuthContext = createContext(null);

export function Logout() {
  const auth = useContext(AuthContext);
  return <div className="console-session-actions">
    <button className="secondary-button" type="button" onClick={auth.logout} disabled={auth.busy}><LogOut size={15} />{auth.busy ? "正在退出…" : "退出登录"}</button>
    {auth.error && <span className="console-session-error" role="alert">{auth.error}</span>}
  </div>;
}

export default function Auth({ children }) {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef(null);
  const requests = useRef(new Set());
  const revision = useRef(0);

  async function request(endpoint, body, token) {
    const controller = new AbortController();
    requests.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(endpoint, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json", ...(token ? { "x-console-token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { response, data: await response.json() };
    } finally { clearTimeout(timer); requests.current.delete(controller); }
  }

  function expire(message) {
    revision.current++;
    endSession();
    for (const controller of requests.current) controller.abort();
    current.current = null;
    setSession(null);
    setChecking(false);
    setBusy(false);
    setError("");
    setNotice(message);
    history.replaceState(null, "", "/login");
  }

  function accept(data, initial = false) {
    if (!data.token || typeof data.expiresIn !== "number" || data.expiresIn <= 0) throw new Error("invalid session");
    if (initial) beginSession();
    current.current = data;
    setSession(data);
    setChecking(false);
    setError("");
    setNotice("");
    history.replaceState(null, "", "/");
  }

  useEffect(() => {
    let stopped = false;
    const expired = () => expire("登录已过期，请重新登录。后台授权任务仍在运行。");
    window.addEventListener("console-session-expired", expired);
    request("/api/auth/session").then(({ response, data }) => {
      if (stopped) return;
      if (response.ok) accept(data, true);
      else if (response.status === 401) expire("");
      else throw new Error();
    }).catch(() => { if (!stopped) { setChecking(false); setError("无法确认登录状态，请检查网络后重新登录。"); } });
    return () => {
      stopped = true;
      revision.current++;
      window.removeEventListener("console-session-expired", expired);
      for (const controller of requests.current) controller.abort();
      endSession();
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => expire("登录已过期，请重新登录。后台授权任务仍在运行。"), session.expiresIn);
    return () => clearTimeout(timer);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let pending = false;
    let lastActivity = 0;
    async function refresh(activity = false) {
      if (pending || stopped || !current.current) return;
      pending = true;
      const version = revision.current;
      try {
        const { response, data } = await request(activity ? "/api/auth/activity" : "/api/auth/session", activity ? {} : undefined, current.current.token);
        if (stopped || version !== revision.current) return;
        if (response.status === 401) expire("登录已过期，请重新登录。后台授权任务仍在运行。");
        else if (response.ok) accept(data);
      } catch {} finally { pending = false; }
    }
    const activity = event => {
      if (!event.isTrusted || Date.now() - lastActivity < 60000) return;
      lastActivity = Date.now();
      void refresh(true);
    };
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 60000);
    window.addEventListener("pointerdown", activity, { passive: true });
    window.addEventListener("keydown", activity);
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [Boolean(session)]);

  async function login(username, password) {
    const version = revision.current;
    const result = await request("/api/auth/login", { username, password });
    if (version !== revision.current) throw new Error("登录状态已变化，请重新登录。");
    if (result.response.ok) accept(result.data, true);
    return result;
  }

  async function logout() {
    if (busy || !current.current) return;
    setBusy(true);
    setError("");
    const version = revision.current;
    try {
      const { response } = await request("/api/auth/logout", {}, current.current.token);
      if (version !== revision.current) return;
      if (!response.ok && response.status !== 401) throw new Error();
      expire("已退出登录。");
    } catch { if (version === revision.current) setError("退出请求失败，尚未确认注销，请重试。"); }
    finally { if (version === revision.current) setBusy(false); }
  }

  if (session) return <AuthContext.Provider value={{ logout, busy, error }}>{children}</AuthContext.Provider>;
  return <main className="console-login-page">
    <header className="console-login-header"><span className="brand-mark"><KeyRound size={20} /></span><strong>toSub2</strong></header>
    <section className="console-login-card" aria-label="管理员登录">
      <h1>登录控制台</h1>
      <p className="console-login-description">管理授权账号，查看同步与在线状态</p>
      {checking ? <div className="console-login-loading" role="status"><LoaderCircle className="spin" size={18} />正在确认登录状态…</div> : <Login onLogin={login} notice={notice} initialError={error} />}
    </section>
    <p className="console-login-footer">登录有效期为 3 天；退出、改密或服务重启后需重新登录</p>
  </main>;
}

function Login({ onLogin, notice, initialError }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [caps, setCaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [field, setField] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const nameInput = useRef(null);
  const passwordInput = useRef(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    if (!retryAt) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setSeconds(remaining);
      if (!remaining) setRetryAt(0);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);

  async function submit(event) {
    event.preventDefault();
    if (busy || seconds) return;
    setError("");
    setField("");
    if (!username.trim()) { setField("username"); nameInput.current.focus(); return; }
    if (!password) { setField("password"); passwordInput.current.focus(); return; }
    setBusy(true);
    try {
      const { response, data } = await onLogin(username, password);
      if (!mounted.current || response.ok) return;
      setError(data.error || "登录失败，请稍后重试。");
      if ([401, 429].includes(response.status)) { setPassword(""); setVisible(false); passwordInput.current.focus(); }
      if (response.status === 429) {
        const delay = Math.min(300, Math.max(1, Number(data.retryAfter) || 60));
        setSeconds(delay);
        setRetryAt(Date.now() + delay * 1000);
      }
    } catch { if (mounted.current) setError("暂时无法连接登录服务，请检查网络后重试。"); }
    finally { if (mounted.current) setBusy(false); }
  }

  return <form onSubmit={submit} noValidate aria-busy={busy}>
    {notice && <p className="console-login-notice" role="status">{notice}</p>}
    <label className="console-login-label" htmlFor="console-username">管理员账号</label>
    <input ref={nameInput} id="console-username" name="username" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} readOnly={busy} aria-invalid={field === "username"} aria-describedby={field === "username" ? "console-name-error" : undefined} />
    {field === "username" && <span className="console-login-field-error" id="console-name-error" role="alert">请输入管理员账号</span>}
    <label className="console-login-label" htmlFor="console-password">密码</label>
    <div className="console-login-password">
      <input ref={passwordInput} id="console-password" name="password" type={visible ? "text" : "password"} value={password} onChange={event => setPassword(event.target.value)} onKeyUp={event => setCaps(event.getModifierState("CapsLock"))} onBlur={() => setCaps(false)} autoComplete="current-password" autoFocus readOnly={busy} aria-invalid={field === "password"} aria-describedby={field === "password" ? "console-password-error" : undefined} />
      <button type="button" onClick={() => setVisible(value => !value)} disabled={busy} aria-label={visible ? "隐藏密码" : "显示密码"} aria-pressed={visible}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
    </div>
    {field === "password" && <span className="console-login-field-error" id="console-password-error" role="alert">请输入密码</span>}
    {caps && <span className="console-login-hint" role="status">大写锁定已开启</span>}
    {(error || initialError) && <p className="console-login-error" role="alert">{error || initialError}</p>}
    <button className="console-login-submit" type="submit" disabled={busy || seconds > 0}>{busy ? <><LoaderCircle className="spin" size={18} />正在登录…</> : seconds ? `${seconds} 秒后重试` : <>登录控制台<ArrowRight size={18} /></>}</button>
    <p className="console-login-hint console-login-private">仅限管理员访问</p>
  </form>;
}
