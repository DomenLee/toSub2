import fs from "node:fs/promises";
import { workspaceOf } from "./identity.mjs";

const terminal = new Set(["completed", "failed", "canceled", "reauth_required", "resume_available"]);
const emailOf = account => String(account?.credentials?.email || account?.extra?.email || account?.name || "").trim().toLowerCase();

function groupsOf(account) {
  const names = new Map();
  for (const id of account.group_ids || []) names.set(Number(id), `分组 #${id}`);
  for (const group of account.groups || []) names.set(Number(group.id), String(group.name || `分组 #${group.id}`));
  for (const item of account.account_groups || []) {
    const id = Number(item.group_id);
    names.set(id, String(item.group?.name || names.get(id) || `分组 #${id}`));
  }
  return [...names].filter(([id]) => Number.isSafeInteger(id) && id > 0).map(([id, name]) => ({ id, name }));
}

export function createAccounts({ jobs, sync, request, lock, removeLocal, now = () => new Date() }) {
  function binding(job) {
    const item = sync.status().find(entry => entry.id === job.id);
    return Number.isSafeInteger(item?.accountID) && item.accountID > 0 ? item.accountID : null;
  }

  async function inspect(job) {
    const accountID = binding(job);
    const base = { id: job.id, email: job.email, accountID };
    if (!accountID) return { ...base, status: "unlinked", message: "未绑定本项目账号，仅删除本地任务" };
    let workspace = sync.workspace(job.id);
    if (!workspace) {
      try {
        const output = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
        if (output.accounts?.length === 1 && emailOf(output.accounts[0]) === job.email.toLowerCase()) workspace = workspaceOf(output.accounts[0]);
      } catch {}
    }
    if (!workspace || workspace.startsWith("authsess_")) throw new Error("缺少可信的真实工作区绑定，请先核对同步记录；禁止仅按邮箱删除");
    let account;
    try { account = await request(`/api/v1/admin/accounts/${accountID}`); }
    catch (error) {
      if (error.status === 404) return { ...base, status: "missing", message: "本项目账号已不存在，确认后仅清理本地任务" };
      throw error;
    }
    if (account?.id !== accountID || account.platform !== "openai" || account.type !== "oauth" || account.parent_account_id || emailOf(account) !== job.email.toLowerCase() || workspaceOf(account) !== workspace) {
      throw new Error("账号编号、邮箱或真实工作区与任务不一致，请先在 Sub2API 核对绑定，未执行删除");
    }
    return { ...base, status: "ready", groups: groupsOf(account), accountStatus: String(account.status || ""), deleting: sync.isDeleting(job.id) };
  }

  async function detail(job, includeStats = true) {
    try {
      if (jobs.get(job.id) !== job) throw new Error("任务已变化，请刷新页面后重试");
      const item = await inspect(job);
      if (!includeStats || item.status !== "ready") return item;
      const endDate = now().toISOString().slice(0, 10);
      const query = new URLSearchParams({ account_id: String(item.accountID), start_date: "1970-01-01", end_date: endDate, timezone: "UTC" });
      try {
        const stats = await request(`/api/v1/admin/usage/stats?${query}`);
        if (typeof stats?.total_actual_cost !== "number" || !Number.isFinite(stats.total_actual_cost)) throw new Error("invalid stats");
        return { ...item, userCost: stats.total_actual_cost, updatedAt: now().toISOString() };
      } catch {
        return { ...item, userCost: null, statsError: "累计扣费读取失败，请点击刷新重试；不影响已确认账号的删除" };
      }
    } catch (error) {
      return { id: job.id, email: job.email, accountID: binding(job), status: "error", error: String(error.message || "关联账号读取失败，请刷新后重试") };
    }
  }

  async function details(selected) {
    const result = [];
    for (let offset = 0; offset < selected.length; offset += 4) result.push(...await Promise.all(selected.slice(offset, offset + 4).map(job => detail(job))));
    return result;
  }

  async function remove(selected, deleteLinkedAccounts, links = []) {
    const expected = new Map(Array.isArray(links) ? links.map(item => [item?.id, item?.accountID]) : []);
    const results = [];
    const completed = new Set();
    for (const job of selected) {
      const result = { id: job.id, email: job.email, accountID: binding(job), deleted: false };
      if (completed.has(job.id)) { results.push({ ...result, deleted: true }); continue; }
      try {
        await lock(job.email, () => sync.run(async () => {
          if (jobs.get(job.id) !== job) throw new Error("任务已变化，请刷新列表，勿重复提交旧任务");
          const matching = [...jobs.values()].filter(item => item.email.toLowerCase() === job.email.toLowerCase());
          if (deleteLinkedAccounts) {
            if (!terminal.has(job.status) || job.child) throw new Error("任务正在进行中，请先停止或完成授权后再联动删除");
            if (matching.length !== 1) throw new Error("同邮箱存在多条任务，请先核对关联账号，未执行联动删除");
            const item = await inspect(job);
            if (!expected.has(job.id) || expected.get(job.id) !== item.accountID) throw new Error("关联账号在确认后发生变化，请关闭弹窗重新核对账号编号");
            result.accountID = item.accountID;
            if (item.status === "ready") {
              await sync.markDeleting(job);
              try { await request(`/api/v1/admin/accounts/${item.accountID}`, { method: "DELETE" }); }
              catch (error) { if (error.status !== 404) throw error; }
              result.remoteDeleted = true;
            }
            if (item.status === "missing") result.remoteDeleted = true;
          }
          for (const item of matching) await sync.markDeleting(item);
          await removeLocal(job.email.toLowerCase());
          result.deleted = true;
          matching.forEach(item => completed.add(item.id));
          try { for (const item of matching) await sync.forget(item.id); }
          catch { result.warning = "任务已删除，但同步状态清理失败，请管理员检查数据目录权限"; }
        }));
      } catch (error) {
        result.error = `${result.remoteDeleted ? "本项目账号已删除，本地清理未完成。" : ""}${error.message || "删除失败"}；请核对该账号后重试删除`;
      }
      results.push(result);
    }
    return { results, deleted: results.filter(item => item.deleted).length, failed: results.filter(item => !item.deleted).length };
  }

  return { details, remove };
}
