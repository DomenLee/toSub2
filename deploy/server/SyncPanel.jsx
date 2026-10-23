import React, { useEffect, useState } from "react";

export default function SyncPanel({ token }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [repair, setRepair] = useState(null);
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
      } catch { if (!controller.signal.aborted) setError("无法读取账号同步状态，请刷新页面；持续失败请检查服务连接。"); }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 5000); }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [token]);
  const retry = async id => {
    setBusy(true);
    try {
      const response = await fetch("/api/auto-sync/retry", { method: "POST", headers: { "content-type": "application/json", "x-console-token": token }, body: JSON.stringify({ id }) });
      if (!response.ok) throw new Error();
      const result = await response.json();
      setItems(result.items);
      setRepair(result.repair);
    } catch { setError(`任务 ${id} 重试请求失败，请刷新页面后重试。`); }
    finally { setBusy(false); }
  };
  const failures = items.filter(item => ["failed", "deleting"].includes(item.status));
  const needsAttention = repair?.items?.some(item => ["blocked", "failed", "limited", "waiting", "sync_pending"].includes(item.status));
  return <section aria-label="账号自动同步" style={{ padding: 14, background: failures.length || error || repair?.error || needsAttention ? "#fff1f0" : "#edf8f2", borderRadius: 10, marginBottom: 16 }}>
    <strong>已连接本项目 · 登录成功后自动新增或更新账号 · 使用默认配置</strong>
    <div>已同步 {items.filter(item => item.status === "synced").length} 个任务{items[0]?.accountID ? ` · 最近账号 #${items[0].accountID}` : ""}</div>
    <div>{repair?.enabled ? "401 自动重新授权已开启 · 每分钟检测 · 间隔至少 15 分钟 · 每账号每天最多 3 次" : "401 自动重新授权未开启"}</div>
    {repair?.lastCheckAt && <div>最近检测：{new Date(repair.lastCheckAt).toLocaleString()}</div>}
    {repair?.error && <p role="alert">{repair.error}</p>}
    {repair?.items?.map(item => <div role={item.status === "recovered" ? "status" : "alert"} key={item.id} style={{ marginTop: 8 }}><strong>{item.email} · 账号 #{item.accountID}</strong>（任务 {item.id}）：{item.message}</div>)}
    {error && <p role="alert">{error}</p>}
    {failures.map(item => <div role="alert" key={item.id} style={{ marginTop: 8 }}><strong>{item.email}</strong>（账号 #{item.accountID || "未绑定"} · 任务 {item.id}）：{item.error}。{item.status !== "deleting" && <button type="button" disabled={busy} onClick={() => retry(item.id)}>立即重试</button>}</div>)}
  </section>;
}
