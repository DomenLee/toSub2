export function tokenWorkspaceOf(account) {
  const ids = [];
  for (const field of ["access_token", "id_token"]) {
    try {
      const claims = JSON.parse(Buffer.from(account.credentials?.[field]?.split(".")[1] || "", "base64url").toString());
      const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (typeof id === "string" && id && !id.startsWith("authsess_")) ids.push(id);
    } catch {}
  }
  if (new Set(ids).size > 1) throw Object.assign(new Error("授权令牌的工作区不一致，请重新授权"), { code: "workspace_mismatch" });
  return ids[0] || "";
}

export function workspaceOf(account) {
  const workspace = tokenWorkspaceOf(account);
  if (workspace) return workspace;
  const stored = String(account.credentials?.chatgpt_account_id || account.extra?.chatgpt_account_id || "");
  return stored.startsWith("authsess_") ? "" : stored;
}

const storedWorkspaces = account => [account.credentials?.chatgpt_account_id, account.extra?.chatgpt_account_id, account.extra?.account_id].filter(value => typeof value === "string" && value);

export function hasLegacyWorkspace(account) {
  return storedWorkspaces(account).some(value => value.startsWith("authsess_"));
}

export function assertBinding(account, { accountID, email, workspace, allowLegacy = false }) {
  const fail = (code, message) => { throw Object.assign(new Error(`账号 #${accountID}：${message}`), { code }); };
  if (account?.id !== accountID || account.platform !== "openai" || account.type !== "oauth" || account.parent_account_id) fail("binding_mismatch", "编号或账号类型与任务不一致，请在 Sub2API 核对原账号。");
  const actualEmail = String(account.credentials?.email || account.extra?.email || account.name || "").trim().toLowerCase();
  if (actualEmail !== email.trim().toLowerCase()) fail("email_mismatch", "邮箱与任务不一致，请在 Sub2API 核对邮箱和绑定记录。");
  if (!workspace || workspace.startsWith("authsess_")) fail("workspace_missing", "缺少可信的工作区绑定，请管理员核对并补齐原账号的绑定记录后重试。");
  const actualWorkspace = workspaceOf(account);
  if ((actualWorkspace && actualWorkspace !== workspace) || storedWorkspaces(account).some(value => !value.startsWith("authsess_") && value !== workspace)) fail("workspace_mismatch", "工作区与原绑定不一致，请重新授权并选择原工作区。");
  const legacy = hasLegacyWorkspace(account);
  if (legacy && !allowLegacy) fail("legacy_workspace", "仍使用旧版会话标识 authsess_，后台将校验并修复；请在自动同步面板查看结果或立即重试。");
  if (!actualWorkspace && !legacy) fail("workspace_missing", "未提供真实工作区，请在 Sub2API 核对原账号的工作区配置后重试。");
  return legacy;
}

export function normalizeAccount(account) {
  const workspace = workspaceOf(account);
  if (!workspace) throw new Error("授权文件缺少真实工作区 ID，请重新授权");
  return {
    ...account,
    credentials: { ...account.credentials, chatgpt_account_id: workspace },
    extra: { ...account.extra, account_id: workspace, chatgpt_account_id: workspace },
  };
}
