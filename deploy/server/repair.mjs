import fs from "node:fs/promises";
import { workspaceOf } from "./identity.mjs";

const terminal = new Set(["completed", "failed", "canceled", "reauth_required", "resume_available"]);
const manual = new Set(["password", "email_otp", "mfa_otp", "phone", "phone_otp", "totp_setup_otp"]);
const day = 24 * 60 * 60_000;
const cooldown = 15 * 60_000;

export function isAuthFailure(account) {
  const message = String(account?.error_message || "");
  return account?.platform === "openai" && account.type === "oauth" && !account.parent_account_id
    && account.status === "error" && /\b401\b/.test(message)
    && !/account_(?:deactivated|deleted|suspended|disabled)|account (?:has been|is) (?:deleted|deactivated|suspended|disabled)/i.test(message);
}

export async function createRepair({ jobs, sync, request, renew, enabled = process.env.TOSUB2_AUTO_REAUTH === "true", stateFile = "/data/repair-state.json", now = Date.now }) {
  let state = {};
  try { state = JSON.parse(await fs.readFile(stateFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let timer;
  let pending;
  let stopped = false;
  let lastCheckAt = null;
  let error = "";
  const save = async () => {
    await fs.writeFile(stateFile + ".tmp", JSON.stringify(state), { mode: 0o600 });
    await fs.rename(stateFile + ".tmp", stateFile);
  };
  const emailOf = account => String(account.credentials?.email || account.extra?.email || account.name || "").trim().toLowerCase();

  async function inspect() {
    if (!enabled || stopped) return;
    error = "";
    try {
      const errors = new Map();
      for (let page = 1; ; page++) {
        if (page > 100) throw new Error();
        const result = await request(`/api/v1/admin/accounts?platform=openai&type=oauth&status=error&page_size=100&page=${page}`);
        if (!Array.isArray(result.items) || !Number.isInteger(result.pages)) throw new Error();
        for (const account of result.items) if (isAuthFailure(account)) errors.set(account.id, account);
        if (page >= result.pages) break;
      }
      for (const item of sync.status()) {
        if (stopped) break;
        const job = jobs.get(item.id);
        const previous = state[item.id];
        const accountID = item.accountID || previous?.accountID;
        if (!job || job.deleted || !Number.isSafeInteger(accountID) || accountID <= 0) continue;
        const account = errors.get(accountID);
        if (!account && !previous) continue;
        const record = state[item.id] = { ...previous, accountID, email: job.email, attempts: (previous?.attempts || []).filter(at => at > now() - day) };
        if (record.startedAt && item.status === "synced" && Date.parse(item.updatedAt) >= record.startedAt && sync.revision(item.id) !== record.revision) {
          record.status = "recovered";
          record.message = "重新授权成功，已更新原账号凭据";
          record.startedAt = null;
          record.recoveredAt = item.updatedAt;
        }
        if (record.startedAt && !terminal.has(job.status)) {
          record.status = manual.has(job.status) ? "waiting" : "running";
          record.message = manual.has(job.status) ? "正在等待验证码或登录验证；若任务未自动继续，请在任务详情完成验证" : "正在自动重新登录并授权";
          continue;
        }
        if (record.startedAt && job.status !== "completed") {
          record.status = "failed";
          record.message = "重新授权未完成，请查看该账号任务详情并处理验证或登录错误";
        }
        if (item.status !== "synced") {
          record.status = "sync_pending";
          record.message = "凭据尚未同步成功，正在重试回写；请处理同步面板中的错误，不会重复登录";
          continue;
        }
        if (!account) continue;
        if (!terminal.has(job.status)) {
          record.status = "waiting";
          record.message = "该账号有进行中的任务，请先完成任务中的验证";
          continue;
        }
        if (record.attempts.length >= 3) {
          record.status = "limited";
          record.message = "24 小时内已自动尝试 3 次，请检查账号和任务错误后手动重新授权";
          continue;
        }
        if (record.attempts.length && now() - record.attempts.at(-1) < cooldown) {
          if (record.status !== "failed") {
            record.status = "cooldown";
            record.message = "仍有 401，等待 15 分钟重试间隔；可在任务详情查看登录结果";
          }
          continue;
        }
        try {
          const current = await request(`/api/v1/admin/accounts/${accountID}`);
          if (!isAuthFailure(current)) continue;
          const output = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
          const source = output.accounts?.[0];
          if (current.id !== accountID || output.accounts?.length !== 1 || !source || emailOf(current) !== job.email.toLowerCase() || emailOf(source) !== job.email.toLowerCase() || !workspaceOf(source) || (workspaceOf(current) ? workspaceOf(current) !== workspaceOf(source) : sync.workspace(item.id) !== workspaceOf(source))) {
            record.status = "blocked";
            record.message = "账号邮箱或工作区与登录任务不一致，请核对账号对应关系";
            continue;
          }
          record.startedAt = now();
          record.revision = sync.revision(item.id);
          record.attempts.push(record.startedAt);
          record.status = "starting";
          record.message = "检测到 401，正在启动重新授权";
          await save();
          if (stopped) break;
          const result = await renew(job);
          if (!result.started) {
            record.attempts.pop();
            record.startedAt = null;
            record.status = "blocked";
            record.message = `${result.reason}；请在任务详情补齐资料或完成一次登录`;
          } else {
            record.status = "running";
            record.message = "正在自动重新登录并授权";
          }
        } catch {
          record.status = "failed";
          record.message = "自动重新授权启动失败，请检查该账号任务详情、数据目录及本项目连接";
        }
      }
      lastCheckAt = new Date(now()).toISOString();
      await save();
    } catch {
      error = "401 检测失败，请检查本项目接口权限、网络和 toSub2 数据目录；一分钟后重试";
    }
  }

  function check() {
    if (!pending) pending = inspect().finally(() => { pending = null; });
    return pending;
  }
  async function tick() {
    await check();
    if (!stopped && enabled) timer = setTimeout(tick, 60_000);
  }
  return {
    check,
    start() { if (enabled && !stopped && !timer && !pending) timer = setTimeout(tick, 1000); },
    async stop() { stopped = true; clearTimeout(timer); await pending; },
    status() { return { enabled, lastCheckAt, error, intervalSeconds: 60, cooldownMinutes: 15, dailyLimit: 3, items: Object.entries(state).filter(([id]) => jobs.has(id) && !jobs.get(id).deleted).map(([id, item]) => ({ id, accountID: item.accountID, email: item.email, status: item.status, message: item.message, attempts: item.attempts.length, recoveredAt: item.recoveredAt })) }; },
  };
}
