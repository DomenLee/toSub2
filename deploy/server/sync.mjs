import crypto from "node:crypto";
import fs from "node:fs/promises";
import { normalizeAccount, workspaceOf } from "./identity.mjs";

export async function createSync({ jobs, request, stateFile = "/data/sync-state.json" }) {
  let state = {};
  try { state = JSON.parse(await fs.readFile(stateFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let queue = Promise.resolve();
  let timer;
  let stopped = false;
  const save = async () => {
    await fs.writeFile(stateFile + ".tmp", JSON.stringify(state), { mode: 0o600 });
    await fs.rename(stateFile + ".tmp", stateFile);
  };
  const emailOf = account => String(account.credentials?.email || account.extra?.email || account.name || "").trim().toLowerCase();

  async function push(job, force) {
    if (job.deleted || state[job.id]?.deleting || job.status !== "completed" || !job.resultSaved) return;
    const previous = state[job.id];
    if (!force && previous?.status === "failed" && Date.now() < previous.retryAt) return;
    let digest;
    try {
      const raw = await fs.readFile(job.outputPath, "utf8");
      const rawDigest = crypto.createHash("sha256").update(raw).digest("hex");
      digest = rawDigest;
      if (previous?.status === "synced" && previous.digest === digest) return;
      const payload = JSON.parse(raw);
      const original = payload.accounts?.[0];
      if (payload.type !== "sub2api-data" || payload.accounts?.length !== 1 || original.platform !== "openai" || original.type !== "oauth" || emailOf(original) !== job.email.toLowerCase() || !original.credentials?.access_token || !original.credentials?.refresh_token) {
        throw new Error("授权文件与账号不匹配，请重新授权");
      }
      const source = normalizeAccount(original);
      const workspaceID = workspaceOf(source);
      if (previous?.accountID && previous.workspaceID && previous.workspaceID !== workspaceID) throw new Error("重新授权选择了不同工作区，请核对原账号，禁止覆盖或自动新增");
      const legacyMatch = account => account.id === previous?.accountID && !workspaceOf(account) && (previous.workspaceID === workspaceID || previous.digest === rawDigest);
      state[job.id] = { ...previous, email: job.email, status: "syncing", updatedAt: new Date().toISOString() };
      await save();
      const matches = [];
      let ambiguousLegacy = false;
      for (let page = 1; ; page++) {
        if (page > 100) throw new Error("账号查询结果过多，请在本项目核对重复账号");
        const result = await request(`/api/v1/admin/accounts?platform=openai&type=oauth&search=${encodeURIComponent(job.email)}&page_size=100&page=${page}`);
        if (!Array.isArray(result.items) || !Number.isInteger(result.pages)) throw new Error("账号查询响应格式异常，请检查本项目接口");
        for (const account of result.items) {
          if (account.platform !== "openai" || account.type !== "oauth" || account.parent_account_id || emailOf(account) !== job.email.toLowerCase()) continue;
          if (workspaceOf(account) === workspaceID || legacyMatch(account)) matches.push(account);
          else if (!workspaceOf(account)) ambiguousLegacy = true;
        }
        if (page >= result.pages) break;
      }
      const linked = matches.find(account => account.id === previous?.accountID);
      if (matches.length > 1 && !linked) throw new Error("发现同邮箱同工作区的重复账号，请在本项目合并后重试");
      if (!matches.length && (previous?.accountID || ambiguousLegacy)) throw new Error("原账号对应关系无法确认，请核对账号与工作区，禁止自动新增重复账号");
      let accountID;
      if (matches.length) {
        accountID = (linked || matches[0]).id;
        const existing = await request(`/api/v1/admin/accounts/${accountID}`);
        if (existing.id !== accountID || emailOf(existing) !== job.email.toLowerCase() || (workspaceOf(existing) !== workspaceID && !legacyMatch(existing))) throw new Error("目标账号已变化，请核对后重试");
        if (previous?.resumeScheduling || (existing.status === "error" && /\b401\b/.test(existing.error_message || ""))) {
          state[job.id].resumeScheduling = true;
          await save();
        }
        await request(`/api/v1/admin/accounts/${accountID}/apply-oauth-credentials`, { method: "POST", body: { type: "oauth", credentials: source.credentials, extra: { account_id: workspaceID, chatgpt_account_id: workspaceID } } });
        await request(`/api/v1/admin/accounts/${accountID}/clear-error`, { method: "POST", body: {} });
        if (state[job.id].resumeScheduling) {
          await request(`/api/v1/admin/accounts/${accountID}/schedulable`, { method: "POST", body: { schedulable: true } });
        }
      } else {
        const { proxy_key, group_ids, proxy_id, ...defaults } = source;
        const created = await request("/api/v1/admin/accounts", { method: "POST", body: defaults, headers: { "Idempotency-Key": "tosub2-" + digest } });
        if (!Number.isSafeInteger(created.id) || created.id <= 0) throw new Error("新增账号响应无有效编号，请核对本项目后重试");
        accountID = created.id;
      }
      state[job.id] = { email: job.email, status: "synced", digest, accountID, workspaceID, updatedAt: new Date().toISOString() };
    } catch (error) {
      state[job.id] = { ...state[job.id], email: job.email, status: "failed", error: error.message, retryAt: Date.now() + 60000, updatedAt: new Date().toISOString() };
    }
    await save();
  }

  function run(operation) {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  }
  function sync(job, force = false) {
    return run(() => push(job, force));
  }
  async function scan() {
    try { for (const job of jobs.values()) { if (stopped) break; await sync(job); } }
    catch { console.error("[sync] 同步状态保存失败，请检查数据目录权限和磁盘空间"); }
    finally { if (!stopped) timer = setTimeout(scan, 10000); }
  }
  return {
    sync,
    run,
    isDeleting(id) { return Boolean(state[id]?.deleting); },
    async markDeleting(job) {
      state[job.id] = { ...state[job.id], email: job.email, deleting: true, status: "deleting", error: "删除尚未完成，自动同步已暂停；请在删除弹窗核对该账号并重试", updatedAt: new Date().toISOString() };
      await save();
    },
    async forget(id) { delete state[id]; await save(); },
    revision(id) { return state[id]?.digest; },
    workspace(id) { return state[id]?.workspaceID; },
    start() { void scan(); },
    async stop() { stopped = true; clearTimeout(timer); await queue; },
    status() { return Object.entries(state).filter(([id]) => jobs.has(id)).map(([id, item]) => ({ id, email: item.email, status: item.status, error: item.error, accountID: item.accountID, updatedAt: item.updatedAt })).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))); },
  };
}

export async function createRequest() {
  const base = process.env.SUB2API_URL || "http://sub2api:8080";
  if (base !== "http://sub2api:8080") throw new Error("Unexpected Sub2API destination");
  const key = (await fs.readFile(process.env.SUB2API_KEY_FILE || "/run/secrets/sub2api-key", "utf8")).trim();
  if (!key || key.length > 512 || /[\r\n]/.test(key)) throw new Error("Missing Sub2API integration key");
  return async (endpoint, options = {}) => {
    let response;
    try {
      response = await fetch(base + endpoint, { method: options.method || "GET", body: options.body ? JSON.stringify(options.body) : undefined, headers: { "content-type": "application/json", "x-api-key": key, ...options.headers }, signal: AbortSignal.timeout(30000), redirect: "error" });
    } catch { throw new Error("本项目接口连接失败，将自动重试，也可点击立即重试"); }
    if (!response.ok) {
      const error = new Error(`本项目接口返回 HTTP ${response.status}，请检查集成权限和账号后重试`);
      error.status = response.status;
      throw error;
    }
    const result = await response.json();
    if (result.code !== 0) throw new Error("本项目拒绝同步，请检查账号配置后重试");
    return result.data;
  };
}
