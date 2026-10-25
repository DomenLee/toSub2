import React, { useEffect, useRef, useState } from "react";
import { currentWindow, usageGroups, usageSummary } from "./usage-state.js";
import { sessionFetch as fetch } from "./session.js";
import "./Usage.css";

const percent = value => value == null ? "待采集" : `${value.toFixed(1)}%`;
const time = value => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未采集";

async function request(token, endpoint, body, signal) {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-console-token": token }, body: JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "查询失败，请稍后重试。");
  return result;
}

export function UsageWindows({ item }) {
  return <div className="usage-windows">
    {[["fiveHour", "5 小时额度"], ["sevenDay", "7 天额度"]].map(([key, label]) => {
      const value = item.usage?.[key];
      const fresh = currentWindow(item, key);
      return <div className="usage-window" key={key}>
        <span>{label}</span><strong>{fresh ? `剩余 ${percent(fresh.remaining)}` : value?.used != null ? "快照已过期" : "尚未采集"}</strong>
        {value?.used != null && <><progress max="100" value={Math.min(100, value.used)} aria-label={`${label}已用 ${percent(value.used)}`} /><small>{fresh ? "已用" : "上次已用"} {percent(value.used)} · 重置 {time(value.resetAt)}</small></>}
      </div>;
    })}
    <p className="usage-note">快照时间：{time(item.usage?.updatedAt)}。过期数据不计入可用额度；百分比无法换算成美元。</p>
  </div>;
}

export function AccountUsage({ token, job, item, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  async function refresh() {
    if (busy || retryAt > Date.now()) return;
    setBusy(true);
    setError("");
    setNotice("");
    controller.current = new AbortController();
    try {
      const result = await request(token, "/api/account-usage/refresh", { ids: [job.id] }, controller.current.signal);
      if (controller.current.signal.aborted) return;
      onChange(result.item);
      setRetryAt(Date.parse(result.retryAt));
      setError(result.error || "");
      if (!result.error) setNotice(`${job.email}：额度快照已读取。`);
    } catch (failure) {
      if (!controller.current.signal.aborted) setError(`${job.email}：${failure.message}`);
    } finally { if (!controller.current.signal.aborted) setBusy(false); }
  }
  return <section aria-label="账号订阅额度" className="account-usage">
    <UsageWindows item={item} />
    <p className="usage-note">主动更新可能产生少量模型探测用量；每账号间隔至少 10 分钟。</p>
    <button type="button" className="secondary-button" onClick={refresh} disabled={busy || retryAt > clock || item.deleting || item.reauthRequired}>{busy ? "正在更新额度…" : retryAt > clock ? `${Math.ceil((retryAt - clock) / 60_000)} 分钟后可更新` : "更新额度"}</button>
    {notice && <p role="status" className="usage-note">{notice}</p>}
    {error && <p role="alert" className="dialog-error">{error}</p>}
  </section>;
}

export function UsageMetrics({ items }) {
  const summary = usageSummary(items);
  return <>
    <div className="quota-metric"><span>额度可用账号</span><strong>{summary.known || summary.exhausted ? summary.available : "待采集"}</strong><small>已核实 {summary.known}/{summary.total} 个账号双窗口</small></div>
    <div className="quota-metric"><span>额度不足 / 耗尽</span><strong>{summary.known || summary.exhausted ? `${summary.low} / ${summary.exhausted}` : "待采集"}</strong><small>不足指任一窗口剩余 ≤20%</small></div>
  </>;
}

function Trend({ token, group }) {
  const region = useRef(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [metric, setMetric] = useState("requests");
  const [revision, setRevision] = useState(0);
  const anchor = group.items[0].id;
  useEffect(() => { region.current?.focus({ preventScroll: true }); region.current?.scrollIntoView?.({ block: "nearest" }); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    request(token, "/api/group-usage/trend", { ids: [anchor], groupID: group.id }, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setResult(data);
      setError(data.error || "");
    }).catch(failure => { if (!controller.signal.aborted) setError(`分组「${group.name}」(#${group.id})：${failure.message}；请稍后重试。`); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [token, group.id, group.name, anchor, revision]);
  const labels = { requests: "请求数", tokens: "Token 数", cost: "用户扣费" };
  const format = value => metric === "cost" ? `$${value.toFixed(4)}` : value.toLocaleString("zh-CN");
  const tick = value => metric === "cost" ? value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${value.toFixed(2)}` : value >= 10000 ? `${(value / 10000).toFixed(1)}万` : String(value);
  const points = result?.points;
  const max = Math.max(1, ...(points || []).map(point => point[metric]));
  return <section ref={region} tabIndex={-1} className="usage-trend" aria-label={`${group.name}近7天趋势`}>
    <div className="usage-section-header"><h4>{group.name} · 近 7 天趋势</h4><button type="button" className="secondary-button" disabled={busy} onClick={() => setRevision(value => value + 1)}>刷新趋势</button></div>
    <p className="usage-note">北京时间，今天尚未结束。统计该分组全部请求日志，可能包含本项目未托管的账号及影子账号；与上方托管账号额度的范围不同。缓存 5 分钟。</p>
    <div className="usage-metric-tabs" aria-label="趋势指标">{Object.entries(labels).map(([key, label]) => <button key={key} type="button" aria-pressed={metric === key} onClick={() => setMetric(key)}>{label}</button>)}</div>
    {busy && <p role="status">正在读取分组「{group.name}」的趋势…</p>}
    {error && <p role="alert" className="dialog-error">{error}</p>}
    {points && <>
      <div className="usage-trend-total">近 7 天{labels[metric]} <strong>{format(points.reduce((sum, point) => sum + point[metric], 0))}</strong>{result.stale && <span>上次成功数据</span>}</div>
      <div className="usage-bars" aria-label={`每日${labels[metric]}`}>
        {points.map(point => <div className="usage-bar-column" key={point.date} title={`${point.date} ${format(point[metric])}`}><span className="usage-bar-value">{tick(point[metric])}</span><div className="usage-bar-track"><div className="usage-bar" style={{ height: `${point[metric] / max * 100}%` }} /></div><span>{point.date.slice(5)}</span></div>)}
      </div>
      {points.every(point => point.requests === 0) && <p className="usage-note">该分组近 7 天没有请求记录。</p>}
      <details className="usage-daily-details"><summary>查看每日明细</summary><div className="usage-table-scroll"><table><thead><tr><th>日期</th><th>请求数</th><th>Token 数</th><th>用户扣费</th></tr></thead><tbody>{points.map(point => <tr key={point.date}><td>{point.date}</td><td>{point.requests.toLocaleString()}</td><td>{point.tokens.toLocaleString()}</td><td>${point.cost.toFixed(6)}</td></tr>)}</tbody></table></div></details>
      <p className="usage-note">查询时间：{time(result.updatedAt)}。用户扣费按现存日志统计，不代表订阅已用额度。</p>
    </>}
  </section>;
}

export function UsagePanel({ token, items }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const groups = usageGroups(items);
  const group = groups.find(value => value.id === selected);
  return <section className="usage-panel" aria-label="分组额度与趋势">
    <button type="button" className="usage-panel-toggle" aria-expanded={open} aria-controls="group-usage-content" onClick={() => setOpen(value => !value)}><span><strong>分组额度与趋势</strong><small>{groups.length} 个分组 · 复用已有快照</small></span><span>{open ? "收起" : "展开查看"}</span></button>
    {open && <div id="group-usage-content" className="usage-panel-content">
      <p className="usage-note">额度仅统计本项目已关联的母账号。剩余为可调度账号有效快照的等权平均，不是美元或可相加的总量；不同套餐额度不同，多分组共享账号，各组不能相加。</p>
      {!groups.length && <p>暂无已关联分组，请先完成账号授权与同步。</p>}
      <div className="usage-group-grid">{groups.map(value => <article className="usage-group-card" key={value.id}>
        <h4>{value.name}{value.id > 0 && <small>#{value.id}</small>}</h4>
        <p>托管 {value.total} 个 · 已确认可用 <strong>{value.available}</strong> 个 · 待确认 {value.unknown} 个</p>
        <div className="usage-group-windows">{[["fiveHour", "5 小时平均剩余"], ["sevenDay", "7 天平均剩余"]].map(([key, label]) => <div key={key}><span>{label}</span><strong>{percent(value[key].value)}</strong><small>有效 {value[key].count}/{value.eligible} 个可调度账号</small></div>)}</div>
        <p className="usage-note">额度不足 {value.low} 个 · 已耗尽 {value.exhausted} 个 · 暂不可调度 {value.total - value.eligible} 个</p>
        {value.id > 0 && <button type="button" className="secondary-button" aria-pressed={selected === value.id} onClick={() => setSelected(current => current === value.id ? null : value.id)}>{selected === value.id ? "收起趋势" : `查看 ${value.name} 趋势`}</button>}
      </article>)}</div>
      {group && <Trend key={group.id} token={token} group={group} />}
    </div>}
  </section>;
}
