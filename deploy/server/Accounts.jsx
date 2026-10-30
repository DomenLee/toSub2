import React, { useEffect, useRef, useState } from "react";
import Modal from "./Dialog.jsx";
import { accountIsOnline, accountState } from "./account-state.js";
import { sessionFetch as fetch } from "./session.js";
import { AccountUsage, UsageWindows } from "./Usage.jsx";

async function request(token, endpoint, body, signal) {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-console-token": token }, body: JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败（HTTP ${response.status}），请刷新后重试`);
  return result;
}

export function WeeklyLimitTag({ item }) {
  if (item?.usage?.weeklyLimit !== true) return null;
  return <span className="weekly-limit-tag" title="仅有 7 天周额度，没有 5 小时额度">周限额</span>;
}

function Summary({ item, children }) {
  const online = accountIsOnline(item);
  const state = accountState({}, item);
  const needsReauth = item.reauthRequired === true;
  const quota = item.quota || {};
  const quotaAmount = value => typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "未提供";
  return <div style={{ marginTop: 10, padding: 12, border: "1px solid #d4dcda", borderRadius: 6, overflowWrap: "anywhere" }}>
    <div className="linked-account-title"><strong>{item.email} · {item.accountID ? `账号 #${item.accountID}` : state.label}</strong><WeeklyLimitTag item={item} /></div>
    {item.status === "ready" && <>
      <div className="linked-account-detail-grid">
        <div><span>当前状态（可调度）</span><strong className={online ? "online" : "offline"}>{state.label}</strong></div>
        <div><span>重新授权</span><strong className={needsReauth ? "reauth" : "authorized"}>{needsReauth ? "需要重新授权" : "授权正常"}</strong></div>
        {quota.supported !== false && <><div><span>配置总额度</span><strong>{quota.total === 0 ? "不限额" : quotaAmount(quota.total)}</strong></div>
        <div><span>配置额度已用</span><strong>{quotaAmount(quota.used)}</strong></div></>}
      </div>
      {children || <UsageWindows item={item} />}
      <div style={{ marginTop: 6 }}>所属分组：{item.groups.length ? item.groups.map(group => `${group.name}（#${group.id}）`).join("、") : "未加入分组"}</div>
      <div>用户累计扣费：{item.userCost === null || item.userCost === undefined ? "暂不可用" : `$${item.userCost.toFixed(6)}`}</div>
      <small>统计本账号现存历史用量日志的用户实际扣费，与订阅额度、账号成本不同；不包含已清理的日志和影子账号用量。</small>
      {item.updatedAt && <div><small>更新于 {new Date(item.updatedAt).toLocaleString()}</small></div>}
    </>}
    {item.message && <p>{item.message}</p>}
    {(item.error || item.statsError) && <p className="dialog-error" role="alert">{item.error || item.statsError}</p>}
    {item.deleting && <p role="alert">该账号有未完成的删除，自动同步已暂停；请重新打开删除弹窗处理。</p>}
  </div>;
}

export function LinkedAccount({ token, job }) {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [item, setItem] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    request(token, "/api/linked-accounts", { ids: [job.id] }, controller.signal).then(result => {
      if (!controller.signal.aborted) setItem(result.items[0]);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(`${job.email}：${failure.message}；请点击刷新重试。`);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, token, job.id, job.email, revision]);
  return <>
    <button type="button" className="selection-text-button account-detail-button" disabled={!token} onClick={() => setOpen(true)}>账号详情</button>
    {open && <Modal title="关联账号详情" onClose={() => setOpen(false)}>
      {loading && <p role="status">正在读取 {job.email} 的关联账号…</p>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {!loading && !error && item && <Summary item={item}><AccountUsage token={token} job={job} item={item} onChange={next => setItem(current => ({ ...current, ...next }))} /></Summary>}
      <div className="dialog-footer"><button type="button" className="primary-button" disabled={loading} onClick={() => setRevision(current => current + 1)}>刷新</button></div>
    </Modal>}
  </>;
}

export function DeleteDialog({ token, jobs, onClose, onDeleted }) {
  const [items, setItems] = useState([]);
  const [results, setResults] = useState([]);
  const [linked, setLinked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const pending = new AbortController();
    setLoading(true);
    setError("");
    request(token, "/api/linked-accounts", { ids: jobs.map(job => job.id) }, pending.signal).then(result => {
      if (!pending.signal.aborted) setItems(result.items);
    }).catch(failure => {
      if (!pending.signal.aborted) setError(`选中任务（${jobs.map(job => job.email).join("、")}）：${failure.message}；请刷新关联信息后重试。`);
    }).finally(() => { if (!pending.signal.aborted) setLoading(false); });
    return () => pending.abort();
  }, [token, jobs, revision]);
  const completed = new Set(results.filter(item => item.deleted).map(item => item.id));
  const remaining = jobs.filter(job => !completed.has(job.id));
  const ready = !loading && !error && items.length === jobs.length && items.filter(item => !completed.has(item.id)).every(item => item.status !== "error");
  async function remove() {
    if (busy || !remaining.length || (linked && !ready)) return;
    setBusy(true);
    setError("");
    controller.current = new AbortController();
    try {
      const result = await request(token, "/api/jobs/delete-batch", { ids: remaining.map(job => job.id), deleteLinkedAccounts: linked, links: items.map(item => ({ id: item.id, accountID: item.accountID })) }, controller.current.signal);
      if (!Array.isArray(result.results)) throw new Error("删除响应异常，请刷新任务列表核对实际结果，不要重复删除");
      setResults(current => [...current.filter(item => completed.has(item.id)), ...result.results]);
      onDeleted(result.results.filter(item => item.deleted).map(item => item.id));
    } catch (failure) {
      if (!controller.current.signal.aborted) setError(`任务 ${remaining.map(job => job.email).join("、")}：${failure.message}；请求可能已执行，请先关闭弹窗并刷新列表核对，再重试。`);
    } finally { if (!controller.current.signal.aborted) setBusy(false); }
  }
  return <Modal title="确认删除任务" busy={busy} onClose={onClose}>
    <p>删除本地任务会同时清理其授权文件和保存的登录资料。</p>
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 12, background: "#fff1f0", borderRadius: 6 }}>
      <input type="checkbox" checked={linked} disabled={busy} onChange={event => setLinked(event.target.checked)} />
      <span><strong>同时删除 Sub2API 中的关联账号</strong><br /><small>默认不勾选。勾选后仅删除已核对的绑定账号；母账号对应的 Spark 影子账号也会连带删除。此操作不可通过回滚镜像撤销。</small></span>
    </label>
    {loading && <p role="status">正在核对关联账号…</p>}
    {error && <p className="dialog-error" role="alert">{error}</p>}
    {items.filter(item => !completed.has(item.id)).map(item => <Summary key={item.id} item={item} />)}
    {results.map(item => <p key={item.id} role={item.deleted && !item.warning ? "status" : "alert"} style={{ color: item.deleted && !item.warning ? "#12715b" : "#a33c31", overflowWrap: "anywhere" }}>
      <strong>{item.email}{item.accountID ? ` · 账号 #${item.accountID}` : ""}</strong>：{item.deleted ? `${item.remoteDeleted ? "关联账号和本地任务已删除" : "本地任务已删除"}${item.warning ? `；${item.warning}` : ""}` : item.error}
    </p>)}
    <div className="dialog-footer">
      {!results.length && <button type="button" className="secondary-button" disabled={loading || busy} onClick={() => setRevision(current => current + 1)}>刷新关联信息</button>}
      <button type="button" className="cancel-button" disabled={busy} onClick={onClose}>{remaining.length ? "取消" : "完成"}</button>
      {!!remaining.length && <button type="button" className="delete-button" disabled={busy || (linked && !ready)} onClick={remove}>{busy ? "正在删除…" : linked ? "删除任务及关联账号" : "仅删除本地任务"}</button>}
    </div>
  </Modal>;
}
