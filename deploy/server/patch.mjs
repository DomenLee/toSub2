import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] || ".");
async function replace(file, before, after) {
  const target = path.join(root, file);
  const source = await fs.readFile(target, "utf8");
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`Upstream changed; review before deployment: ${file}`);
  await fs.writeFile(target, source.replace(before, after));
}
await replace("src/console-server.mjs", 'import react from "@vitejs/plugin-react";\nimport { createServer as createViteServer } from "vite";\nimport { createCredentialStore } from "./credential-store.mjs";', 'import { authorize, serveStatic, createCredentialStore } from "./server-security.mjs";\nimport { createSync, createRequest } from "./server-sync.mjs";\nimport { createRepair } from "./server-repair.mjs";');
await replace("src/console-server.mjs", "const MAX_ACTIVE_JOBS = 20;", "const MAX_ACTIVE_JOBS = 2;\nprocess.umask(0o077);");
await replace("src/console-server.mjs", "const jobs = new Map();", "const jobs = new Map();\nconst accountSync = await createSync({ jobs, request: await createRequest() });");
await replace("src/console-server.mjs", `const vite = await createViteServer({
  root: WEB_ROOT,
  configFile: false,
  appType: "spa",
  plugins: [react()],
  server: {
    middlewareMode: true,
    hmr: { port: hmrPort, clientPort: hmrPort },
  },
});`, `const accountRepair = await createRepair({
  jobs,
  sync: accountSync,
  request: await createRequest(),
  renew: job => withEmailJobLock(job.email, async () => {
    if (shuttingDown || job.deleted || jobs.get(job.id) !== job || !canForceRelogin(job)) return { started: false, reason: "任务正在进行中、已删除或服务正在关闭" };
    await reloadMissingJobCredentials(job);
    const eligibility = getAutoRepairEligibility(job);
    if (!eligibility.eligible) return { started: false, reason: eligibility.reason };
    await forceReloginJob(job);
    recordJobOperation(job, "automatic_relogin");
    await saveJobMetadata(job);
    return { started: true };
  }),
});
accountSync.start();
accountRepair.start();`);
await replace("src/console-server.mjs", "    enforceUtf8ContentType(res);", "    if (!await authorize(req, res)) return;\n    enforceUtf8ContentType(res);");
await replace("src/console-server.mjs", 'const consoleToken = crypto.randomBytes(24).toString("base64url");', '');
await replace("src/console-server.mjs", "      token: consoleToken,", "      token: req.consoleSession.token,");
await replace("src/console-server.mjs", "        retry: true,", "        retry: true,\n        sessionAuth: true,");
await replace("src/console-server.mjs", '  if (req.headers["x-console-token"] !== consoleToken) {', '  if (req.headers["x-console-token"] !== req.consoleSession.token) {');
await replace("src/console-server.mjs", `    vite.middlewares(req, res, (error) => {
      if (error) sendJson(res, 500, { error: error.message || "Page rendering failed" });
    });`, "    await serveStatic(req, res, requestUrl.pathname);");
await replace("src/console-server.mjs", '  if (req.method === "GET" && requestUrl.pathname === "/api/jobs") {', `  if (req.method === "GET" && requestUrl.pathname === "/api/auto-sync") {
    sendJson(res, 200, { items: accountSync.status(), repair: accountRepair.status() });
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/api/auto-sync/retry") {
    const body = await readJson(req);
    const job = jobs.get(body.id);
    if (!job) throw httpError(404, "任务不存在，请刷新任务列表");
    await accountSync.sync(job, true);
    sendJson(res, 200, { items: accountSync.status(), repair: accountRepair.status() });
    return;
  }
  if (requestUrl.pathname.startsWith("/api/sub2api/")) {
    throw httpError(403, "已使用服务端自动同步，无需手动配置推送或开启号池监控");
  }
  if (req.method === "GET" && requestUrl.pathname === "/api/jobs") {`);
await replace("src/console-server.mjs", "        sub2apiUpload: true,", "        sub2apiUpload: false,");
await replace("src/console-server.mjs", "        sub2apiMonitor: true,", "        sub2apiMonitor: false,");
await replace("src/console-server.mjs", "    await finishSub2ApiAutoRepairSuccess(job);", "    await accountSync.sync(job);\n    await finishSub2ApiAutoRepairSuccess(job);");
await replace("src/console-server.mjs", "    queueSchedulingPaused = true;", "    queueSchedulingPaused = true;\n    await accountRepair.stop();");
await replace("src/console-server.mjs", "    await vite.close();", "    await accountSync.stop();");
await replace("src/console-server.mjs", 'console.log("[note] LAN access is enabled without authentication. Keep downloaded OAuth files private.");', 'console.log("[note] Console data and operations require session authentication.");');
await replace("src/tls-transport.mjs", "verifyTls: shouldVerifyTlsForProxy(proxy)", "verifyTls: true");
await replace("src/protocol-login.mjs", "options.mode ? { mode: options.mode } : undefined", "{ mode: options.mode || 0o600 }");
await replace("src/protocol-login.mjs", '  const chatgptAccountId = claims.sid || "";', '  const chatgptAccountId = authClaims.chatgpt_account_id || decodeJwtPayload(tokenSet.access_token)["https://api.openai.com/auth"]?.chatgpt_account_id || "";\n  if (!chatgptAccountId || chatgptAccountId.startsWith("authsess_")) throw new Error("OAuth token has no valid ChatGPT workspace ID");');
await replace("src/protocol-login.mjs", '      const accountId = claims.sid || credentials.chatgpt_account_id || "";', '      const accountId = authClaims.chatgpt_account_id || decodeJwtPayload(tokenSet.access_token)["https://api.openai.com/auth"]?.chatgpt_account_id || "";\n      if (!accountId || accountId.startsWith("authsess_")) throw new Error("OAuth token has no valid ChatGPT workspace ID");');
const webFile = path.join(root, "web/src/main.jsx");
let web = await fs.readFile(webFile, "utf8");
const start = web.indexOf('        <div className="provider-toolbar sub2api-toolbar"');
const end = web.indexOf('        <div className="provider-toolbar account-proxy-toolbar"', start);
if (start < 0 || end < 0) throw new Error("Upstream Sub2API toolbar changed");
web = 'import Auth, { Logout } from "./Auth.jsx";\nimport { sessionFetch as fetch } from "./session.js";\nimport SyncPanel from "./SyncPanel.jsx";\n' + web.slice(0, start) + '        <SyncPanel token={token} accountIssues={accountIssueCount} accountError={linkedAccountError} onChange={refreshLinkedAccounts} />\n\n' + web.slice(end);
await fs.writeFile(webFile, web);
await replace("web/src/main.jsx", "appRoot.render(<App />);", "appRoot.render(<Auth><App /></Auth>);");
await replace("web/src/main.jsx", '        <div className="summary" aria-label="任务统计">', '        <div className="summary" aria-label="任务统计">\n          <Logout />');

await replace("src/console-server.mjs", 'import { createRepair } from "./server-repair.mjs";', 'import { createRepair } from "./server-repair.mjs";\nimport { createAccounts } from "./server-accounts.mjs";');
await replace("src/console-server.mjs", "const accountSync = await createSync({ jobs, request: await createRequest() });", "const accountRequest = await createRequest();\nconst accountSync = await createSync({ jobs, request: accountRequest });\nconst linkedAccounts = createAccounts({ jobs, sync: accountSync, request: accountRequest, lock: withEmailJobLock, removeLocal: deleteJobsByEmail });");
await replace("src/console-server.mjs", "    if (shuttingDown || job.deleted || jobs.get(job.id) !== job || !canForceRelogin(job))", "    if (shuttingDown || job.deleted || accountSync.isDeleting(job.id) || jobs.get(job.id) !== job || !canForceRelogin(job))");
await replace("src/console-server.mjs", '  if (requestUrl.pathname.startsWith("/api/sub2api/")) {', `  if (req.method === "POST" && requestUrl.pathname === "/api/linked-accounts") {
    const body = await readJson(req);
    sendJson(res, 200, { items: await linkedAccounts.details(resolveSelectedJobs(body.ids), body.includeStats !== false) });
    return;
  }
  if (requestUrl.pathname.startsWith("/api/sub2api/")) {`);
await replace("src/console-server.mjs", `    const emails = [...new Set(selected.map((job) => job.email.toLowerCase()))];
    await Promise.all(emails.map((email) => withEmailJobLock(email, () => deleteJobsByEmail(email))));
    sendJson(res, 200, { deleted: emails.length });`, `    if (body.deleteLinkedAccounts !== undefined && typeof body.deleteLinkedAccounts !== "boolean") throw httpError(400, "删除选项格式错误，请刷新页面后重试");
    sendJson(res, 200, await linkedAccounts.remove(selected, body.deleteLinkedAccounts === true, body.links));`);
await replace("src/console-server.mjs", "    jobs.delete(job.id);", "");
await replace("src/console-server.mjs", "    deleteStoredLoginCredentials(email),\n  ]);\n  scheduleQueuedJobs();", "    deleteStoredLoginCredentials(email),\n  ]);\n  matching.forEach((job) => jobs.delete(job.id));\n  scheduleQueuedJobs();");
await replace("src/console-server.mjs", "        sub2apiMonitor: false,", "        sub2apiMonitor: false,\n        linkedAccounts: true,");
await replace("web/src/main.jsx", 'import SyncPanel from "./SyncPanel.jsx";', 'import SyncPanel from "./SyncPanel.jsx";\nimport { LinkedAccount, DeleteDialog } from "./Accounts.jsx";');
await replace("web/src/main.jsx", '  const [batchAction, setBatchAction] = useState("");', '  const [batchAction, setBatchAction] = useState("");\n  const [deleteJobs, setDeleteJobs] = useState(null);');
await replace("web/src/main.jsx", `    if (!window.confirm(\`确定删除选中的 \${selectedJobIds.size} 条任务吗？对应的本地授权文件也会被删除。\`)) return;
    setBatchAction("delete");
    try {
      await apiFetch(token, "/api/jobs/delete-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setJobs((current) => current.filter((job) => !selectedJobIds.has(job.id)));
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }`, `    setDeleteJobs([...selectedJobIds].map((id) => jobSelectionIndex.find((job) => job.id === id) || { id, email: id }));`);
await replace("web/src/main.jsx", "    </main>\n  );\n}\n\nfunction EmptyState", `      {deleteJobs && <DeleteDialog token={token} jobs={deleteJobs} onClose={() => setDeleteJobs(null)} onDeleted={(ids) => {
        const deleted = new Set(ids);
        setJobs((current) => current.filter((job) => !deleted.has(job.id)));
        setSelectedJobIds((current) => new Set([...current].filter((id) => !deleted.has(id))));
      }} />}
    </main>
  );
}

function EmptyState`);
await replace("web/src/main.jsx", "              <LoginMethodBadge job={job} />", "              <LoginMethodBadge job={job} />\n              <LinkedAccount token={token} job={job} />");
