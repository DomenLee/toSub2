import { accountIsOnline } from "./account-state.js";

export function currentWindow(item, key, now = Date.now()) {
  const value = item?.usage?.[key];
  if (!value || !Number.isFinite(value.remaining)) return null;
  const updated = Date.parse(item.usage.updatedAt);
  const reset = Date.parse(value.resetAt);
  if (value.state !== "fresh" || !Number.isFinite(updated) || !Number.isFinite(reset) || reset <= now || now - updated > 15 * 60_000 || updated > now + 60_000) return null;
  return value;
}

export function usageSummary(items) {
  const unique = [...new Map(items.filter(item => item?.status === "ready" && Number.isSafeInteger(item.accountID)).map(item => [item.accountID, item])).values()];
  const eligible = unique.filter(item => accountIsOnline(item) && !item.usage?.blocked);
  const known = unique.filter(item => currentWindow(item, "fiveHour") && currentWindow(item, "sevenDay"));
  const remaining = item => Math.min(currentWindow(item, "fiveHour").remaining, currentWindow(item, "sevenDay").remaining);
  const available = known.filter(item => eligible.includes(item) && remaining(item) > 0);
  const average = key => {
    const values = eligible.map(item => currentWindow(item, key)?.remaining).filter(Number.isFinite);
    return { count: values.length, value: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null };
  };
  return { total: unique.length, eligible: eligible.length, known: known.length, available: available.length, low: available.filter(item => remaining(item) <= 20).length, exhausted: unique.filter(item => ["fiveHour", "sevenDay"].some(key => currentWindow(item, key)?.remaining === 0)).length, unknown: unique.length - known.length, fiveHour: average("fiveHour"), sevenDay: average("sevenDay") };
}

export function usageGroups(items) {
  const groups = new Map();
  for (const item of items.filter(item => item?.status === "ready")) {
    for (const group of item.groups?.length ? item.groups : [{ id: 0, name: "未分组" }]) {
      if (!groups.has(group.id)) groups.set(group.id, { ...group, items: [] });
      groups.get(group.id).items.push(item);
    }
  }
  return [...groups.values()].sort((left, right) => left.id - right.id).map(group => ({ ...group, ...usageSummary(group.items) }));
}
