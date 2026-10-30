import fs from "node:fs/promises";

const minute = 60_000;
const failure = (status, message) => Object.assign(new Error(message), { status });
const timestamp = value => typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
const numeric = value => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) ? Number(value) : null;

export function weeklyLimitOf(account) {
  const extra = account.extra || {};
  return numeric(extra.codex_7d_window_minutes) === 7 * 24 * 60 && numeric(extra.codex_5h_window_minutes) === 0;
}

export function usageOf(account, now = Date.now()) {
  const extra = account.extra || {};
  const updated = timestamp(extra.codex_usage_updated_at);
  const window = name => {
    const used = numeric(extra[`codex_${name}_used_percent`]);
    let reset = timestamp(extra[`codex_${name}_reset_at`]);
    const after = numeric(extra[`codex_${name}_reset_after_seconds`]);
    if (!Number.isFinite(reset) && Number.isFinite(updated) && after !== null && after >= 0) reset = updated + after * 1000;
    if (used === null || used < 0 || used > 10000) return { state: "missing", used: null, remaining: null, resetAt: null };
    const fresh = Number.isFinite(updated) && updated <= now + minute && now - updated <= 15 * minute && Number.isFinite(reset) && reset > now;
    return { state: fresh ? "fresh" : "stale", used, remaining: Math.max(0, 100 - used), resetAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null };
  };
  const blocked = [account.rate_limit_reset_at, account.overload_until, account.temp_unschedulable_until].some(value => timestamp(value) > now)
    || account.auto_pause_on_expired === true && Number.isFinite(account.expires_at) && account.expires_at * 1000 <= now;
  return { updatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : null, blocked, weeklyLimit: weeklyLimitOf(account), fiveHour: window("5h"), sevenDay: window("7d") };
}

export function createUsage({ request, inspect, now = Date.now, stateFile = "/data/usage-refresh.json" }) {
  const pending = new Map();
  const trends = new Map();
  let active = 0;
  let attempts;
  let loaded;
  let writes = Promise.resolve();

  async function load() {
    if (!loaded) loaded = fs.readFile(stateFile, "utf8").then(raw => {
      const value = JSON.parse(raw);
      if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
      attempts = Object.fromEntries(Object.entries(value).filter(([key, time]) => /^\d+$/.test(key) && Number.isFinite(time) && time > now() - 24 * 60 * minute));
    }).catch(error => {
      if (error.code !== "ENOENT") throw failure(503, "额度刷新记录不可读，请管理员检查数据文件后重试。");
      attempts = {};
    });
    await loaded;
  }

  async function run(operation) {
    if (active >= 2) throw failure(429, "已有两个用量查询正在进行，请稍后重试。");
    active++;
    try { return await operation(); } finally { active--; }
  }

  async function refresh(job) {
    const item = await inspect(job);
    if (item.status !== "ready" || item.deleting) throw failure(409, "该账号尚未完成有效绑定或正在删除，请先核对账号状态。");
    if (item.reauthRequired) throw failure(409, `账号 #${item.accountID} 需要重新授权，请完成授权后更新额度。`);
    await load();
    for (const [id, attempted] of Object.entries(attempts)) if (attempted < now() - 24 * 60 * minute) delete attempts[id];
    const key = `account:${item.accountID}`;
    if (pending.has(key)) return pending.get(key);
    const retryAt = (attempts[item.accountID] || 0) + 10 * minute;
    if (retryAt > now()) return { item, retryAt: new Date(retryAt).toISOString(), error: `账号 #${item.accountID} 正在冷却，请在 ${new Date(retryAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）后重试。` };
    if (Object.keys(attempts).length >= 2048 && !attempts[item.accountID]) throw failure(429, "额度刷新账号数达到上限，请稍后重试。");
    const operation = run(async () => {
      attempts[item.accountID] = now();
      writes = writes.catch(() => {}).then(async () => {
        await fs.writeFile(stateFile + ".tmp", JSON.stringify(attempts), { mode: 0o600 });
        await fs.rename(stateFile + ".tmp", stateFile);
      });
      try { await writes; } catch { throw failure(503, "额度刷新记录保存失败，请管理员检查数据目录权限后重试。"); }
      let error;
      try { await request(`/api/v1/admin/accounts/${item.accountID}/usage`, { timeoutMs: 20000 }); }
      catch { error = `账号 #${item.accountID} 额度查询失败，保留上次快照；请检查授权和网络，10 分钟后重试。`; }
      const latest = await inspect(job);
      if (latest.accountID !== item.accountID || latest.status !== "ready" || latest.deleting) throw failure(409, "查询期间账号绑定或删除状态发生变化，请刷新列表后核对。");
      const fresh = [latest.usage?.fiveHour, latest.usage?.sevenDay].every(value => value?.state === "fresh");
      return { item: latest, retryAt: new Date(attempts[item.accountID] + 10 * minute).toISOString(), error: error || (fresh ? null : `账号 #${item.accountID} 暂未取得完整的新快照；请稍后刷新快照查看，仍无数据时检查授权并在冷却结束后重试。`) };
    });
    pending.set(key, operation);
    try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
  }

  async function trend(job, groupID) {
    if (!Number.isSafeInteger(groupID) || groupID <= 0) throw failure(400, "请选择有效分组后重试。");
    const item = await inspect(job);
    const group = item.groups?.find(value => value.id === groupID);
    if (item.status !== "ready" || item.deleting || !group) throw failure(409, "该账号已不属于所选分组，请刷新列表后重新选择分组。");
    const end = new Date(now() + 8 * 60 * minute).toISOString().slice(0, 10);
    const dates = Array.from({ length: 7 }, (_, index) => new Date(Date.parse(end + "T00:00:00Z") - (6 - index) * 86400000).toISOString().slice(0, 10));
    const key = `group:${groupID}:${end}`;
    const cached = trends.get(key);
    if (cached && cached.expires > now()) return cached.result;
    if (pending.has(key)) return pending.get(key);
    const operation = run(async () => {
      let result;
      try {
        const query = new URLSearchParams({ group_id: String(groupID), start_date: dates[0], end_date: end, granularity: "day", timezone: "Asia/Shanghai" });
        const response = await request(`/api/v1/admin/dashboard/trend?${query}`, { timeoutMs: 15000 });
        if (!Array.isArray(response.trend) && response.trend !== null) throw new Error();
        const rows = new Map();
        for (const row of response.trend || []) {
          if (!dates.includes(row.date) || rows.has(row.date) || [row.requests, row.total_tokens, row.actual_cost].some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error();
          rows.set(row.date, { date: row.date, requests: row.requests, tokens: row.total_tokens, cost: row.actual_cost });
        }
        result = { groupID, groupName: group.name, updatedAt: new Date(now()).toISOString(), stale: false, points: dates.map(date => rows.get(date) || { date, requests: 0, tokens: 0, cost: 0 }) };
      } catch {
        result = { ...(cached?.result || { groupID, groupName: group.name, points: null }), stale: true, error: `分组「${group.name}」(#${groupID}) 近 7 天趋势读取失败，请 1 分钟后重试；已显示的数据为上次成功结果。` };
      }
      if (trends.size >= 100 && !trends.has(key)) trends.delete(trends.keys().next().value);
      trends.set(key, { result, expires: now() + (result.stale ? minute : 5 * minute) });
      return result;
    });
    pending.set(key, operation);
    try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
  }

  return { refresh, trend };
}
