export function workspaceOf(account) {
  const ids = [];
  for (const field of ["access_token", "id_token"]) {
    try {
      const claims = JSON.parse(Buffer.from(account.credentials?.[field]?.split(".")[1] || "", "base64url").toString());
      const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (typeof id === "string" && id && !id.startsWith("authsess_")) ids.push(id);
    } catch {}
  }
  if (new Set(ids).size > 1) throw new Error("授权令牌的工作区不一致，请重新授权");
  if (ids.length) return ids[0];
  const stored = String(account.credentials?.chatgpt_account_id || account.extra?.chatgpt_account_id || "");
  return stored.startsWith("authsess_") ? "" : stored;
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
