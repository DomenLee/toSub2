export function accountIsOnline(item) {
  return item?.status === "ready" && item.accountStatus === "active" && item.schedulable === true && !item.deleting && !item.reauthRequired;
}

export function accountNeedsReauth(job, item) {
  return job.status === "reauth_required" || item?.reauthRequired === true;
}

export function accountState(job, item) {
  if (!item) return { label: "状态待读取", kind: "pending", attention: false };
  if (item.deleting) return { label: "删除待处理", kind: "offline", attention: true };
  if (item.status === "error") return { label: item.code === "binding_mismatch" ? "绑定待核对" : "读取失败", kind: "offline", attention: true };
  if (item.status === "missing") return { label: "关联账号不存在", kind: "offline", attention: true };
  if (item.syncStatus === "failed") return { label: "同步失败", kind: "offline", attention: true };
  if (item.status === "unlinked") return { label: job.status === "completed" ? "待同步" : "待完成授权", kind: "pending", attention: false };
  if (accountNeedsReauth(job, item)) return { label: "需重新授权", kind: "reauth", attention: true };
  if (accountIsOnline(item)) return { label: "在线", kind: "online", attention: false };
  return { label: "暂停 / 不可用", kind: "offline", attention: true };
}

export function configuredQuota(items, field) {
  const values = items.filter(item => item?.status === "ready" && item.quota?.supported !== false).map(item => item.quota?.[field]).filter(value => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return { text: "未提供", count: 0 };
  const unlimited = field === "total" && values.includes(0);
  return { text: unlimited ? "含不限额" : `$${values.reduce((sum, value) => sum + value, 0).toFixed(2)}`, count: values.length };
}
