import React, { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, ShieldCheck } from "lucide-react";
import "./SyncPanel.css";

const ATTENTION_STATUSES = new Set(["blocked", "failed", "limited", "waiting", "sync_pending"]);

export default function SyncPanel({ token, accountIssues = 0, accountError, onChange }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [repair, setRepair] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const previousKey = useRef(null);
  const syncKey = JSON.stringify(items.map(item => [item.id, item.status, item.accountID, item.updatedAt]));
  useEffect(() => {
    if (previousKey.current !== null && previousKey.current !== syncKey) onChange?.();
    previousKey.current = syncKey;
  }, [syncKey, onChange]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let timer;
    const refresh = async () => {
      try {
        const response = await fetch("/api/auto-sync", { headers: { "x-console-token": token }, signal: controller.signal });
        if (!response.ok) throw new Error();
        const result = await response.json();
        setItems(result.items);
        setRepair(result.repair);
        setError("");
      } catch {
        if (!controller.signal.aborted) setError("无法读取账号同步状态，请刷新页面；持续失败请检查服务连接。");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [token]);

  const retry = async id => {
    setBusy(true);
    try {
      const response = await fetch("/api/auto-sync/retry", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      setItems(result.items);
      setRepair(result.repair);
      setError("");
    } catch {
      setError(`任务 ${id} 重试请求失败，请刷新页面后重试。`);
    } finally {
      setBusy(false);
    }
  };

  const failures = useMemo(() => items.filter(item => ["failed", "deleting"].includes(item.status)), [items]);
  const repairItems = Array.isArray(repair?.items) ? repair.items : [];
  const attentionItems = repairItems.filter(item => ATTENTION_STATUSES.has(item.status));
  const recoveredCount = repairItems.filter(item => item.status === "recovered").length;
  const hasAttention = Boolean(failures.length || attentionItems.length || error || repair?.error || accountIssues || accountError);
  const hasDetails = Boolean(repair?.enabled || repair?.lastCheckAt || repairItems.length || items.length);
  const statusKind = hasAttention ? "attention" : repair?.enabled ? "active" : "idle";
  const statusLabel = hasAttention ? "需要处理" : repair ? "同步服务运行中" : "读取中";

  return (
    <section className={`sync-panel sync-panel-${statusKind}`} aria-label="账号自动同步">
      <div className="sync-panel-summary">
        <div className="sync-panel-icon" aria-hidden="true">
          {hasAttention ? <CircleAlert size={18} /> : repair?.enabled ? <ShieldCheck size={18} /> : <CheckCircle2 size={18} />}
        </div>
        <div className="sync-panel-copy">
          <div className="sync-panel-title">
            <strong>账号自动同步</strong>
            <span className="sync-panel-badge">{statusLabel}</span>
          </div>
          <div className="sync-panel-meta">
            <span>已同步 {items.filter(item => item.status === "synced").length} 个任务</span>
            {recoveredCount > 0 && <span className="sync-secondary-meta">最近自动修复 {recoveredCount} 个账号</span>}
            <span className="sync-secondary-meta">{repair?.enabled ? "401 自动修复已开启" : repair ? "401 自动修复未开启" : "自动修复状态读取中"}</span>
            {repair?.lastCheckAt && <span className="sync-secondary-meta">最近检查 {formatRelativeTime(repair.lastCheckAt)}</span>}
            {accountIssues > 0 && <span>{accountIssues} 个账号需处理，见账号列表</span>}
            {accountError && <span>账号状态读取失败，见概览提示</span>}
          </div>
        </div>
        {hasDetails && (
          <button
            type="button"
            className="sync-panel-toggle"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen(current => !current)}
          >
            {detailsOpen ? "收起详情" : "查看详情"}
            {detailsOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        )}
      </div>

      {(error || repair?.error || failures.length > 0 || attentionItems.length > 0) && (
        <div className="sync-panel-alert" role="alert">
          <CircleAlert size={16} />
          <div className="sync-panel-alert-list">
            {error && <div>{error}</div>}
            {repair?.error && <div>{repair.error}</div>}
            {attentionItems.map(item => <div key={`repair-${item.id}`}>{item.email}（账号 #{item.accountID || "未绑定"}）：{item.message || item.error || "需要人工处理"}</div>)}
            {failures.map(item => (
              <div className="sync-panel-alert-item" key={item.id}>
                <span><strong>{item.email}</strong>（账号 #{item.accountID || "未绑定"}）：{item.error || "同步失败"}</span>
                {item.status !== "deleting" && <button type="button" disabled={busy} onClick={() => retry(item.id)}>立即重试</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {detailsOpen && (
        <div className="sync-panel-details">
          <div className="sync-panel-detail-grid">
            <div><span>同步方式</span><strong>登录成功后自动新增或更新账号</strong></div>
            <div><span>账号配置</span><strong>使用默认配置</strong></div>
            <div><span>检测规则</span><strong>{repair?.enabled ? "每分钟检测 · 间隔至少 15 分钟 · 每账号每天最多 3 次" : "401 自动修复未开启"}</strong></div>
            {repair?.lastCheckAt && <div><span>最近检测时间</span><strong>{new Date(repair.lastCheckAt).toLocaleString()}</strong></div>}
          </div>
          {repairItems.length > 0 ? (
            <div className="sync-panel-events" aria-label="最近自动修复记录">
              {repairItems.map(item => (
                <div className={`sync-panel-event ${item.status === "recovered" ? "success" : "attention"}`} key={item.id}>
                  {item.status === "recovered" ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
                  <div className="sync-panel-event-copy">
                    <strong>{item.email} · 账号 #{item.accountID || "未绑定"}</strong>
                    <span>{item.message || item.error || "暂无说明"}</span>
                  </div>
                  <span className="sync-panel-event-task">任务 {item.id}</span>
                </div>
              ))}
            </div>
          ) : <div className="sync-panel-empty">暂无自动修复记录</div>}
        </div>
      )}
    </section>
  );
}

function formatRelativeTime(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "刚刚";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  return `${Math.floor(elapsed / (60 * 60_000))} 小时前`;
}
