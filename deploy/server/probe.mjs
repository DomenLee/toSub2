import fs from "node:fs/promises";

const base = "http://127.0.0.1:4399";
const password = (await fs.readFile(process.env.CONSOLE_PASSWORD_FILE || "/run/secrets/console-password", "utf8")).trim();
const headers = { Origin: process.env.PUBLIC_ORIGIN, "content-type": "application/json" };
const request = (endpoint, options = {}) => fetch(base + endpoint, { ...options, headers: { ...headers, ...options.headers }, redirect: "error", signal: AbortSignal.timeout(15000) });
const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password }) });
let session = false;
if (login.ok) {
  const data = await login.json();
  const cookie = login.headers.get("set-cookie");
  if (!cookie?.startsWith("__Host-tosub2-session=") || !data.token) throw new Error("Invalid console session response");
  headers.Cookie = cookie.split(";")[0];
  headers["x-console-token"] = data.token;
  session = true;
} else if (process.env.TOSUB2_PROBE_SESSION !== "true" && login.status === 401 && login.headers.get("www-authenticate")?.startsWith("Basic ")) {
  headers.Authorization = "Basic " + Buffer.from("admin:" + password).toString("base64");
} else {
  throw new Error("Console login check failed");
}
try {
  const response = await request("/api/bootstrap");
  if (!response.ok) throw new Error("Console bootstrap check failed");
  const bootstrap = await response.json();
  if (!bootstrap.token || !bootstrap.features?.linkedAccounts) throw new Error("Console feature check failed");
  if (process.env.TOSUB2_PROBE_SESSION === "true" && !bootstrap.features.sessionAuth) throw new Error("Console session feature check failed");
  headers["x-console-token"] = bootstrap.token;
  if (process.env.TOSUB2_PROBE_MODE === "idle") {
    const response = await request("/api/jobs");
    if (!response.ok) throw new Error("Cannot check active jobs");
    const page = await response.json();
    if (!page.stats || page.stats.active || page.stats.queued) throw new Error("Active or queued login tasks exist; finish them, then rerun deployment");
  }
  if (session) {
    const anonymous = await fetch(base + "/api/bootstrap", { signal: AbortSignal.timeout(15000) });
    if (anonymous.status !== 401 || anonymous.headers.has("www-authenticate")) throw new Error("Unauthenticated console guard check failed");
    const health = await request("/healthz");
    if (!health.ok) throw new Error("Health check failed");
  }
} finally {
  if (session) {
    const response = await request("/api/auth/logout", { method: "POST", body: "{}" });
    if (!response.ok) throw new Error("Probe session cleanup failed");
  }
}
