# toSub2 独立服务

- 使用 `DomenLee/toSub2` 的 `main`；公网域名 `tosub.gptplusch.store`，服务器 `45.77.27.100`，独立 Compose 目录 `/opt/tosub2`。
- 修改 Git 地址为 `https://github.com/DomenLee/toSub2.git`，本地目录为 `/Users/lifengdem1pro/Documents/students/toSub2`。关联账号删除、分组、用户累计扣费在本仓库实现，复用 Sub2API 现有接口，不误改其他仓库。
- 本项目是独立登录控制台，通过现有 API 向 Sub2API 自动新增或更新账号，不修改 Sub2API 业务代码。
- 部署补丁、Dockerfile、测试和运维说明在 `deploy/server/`。先读该目录 README；构建时执行精确补丁，修改上游适配必须运行同步与安全测试。
- 2026-10-24 新增 `.github/workflows/deploy.yml`：main → Ubuntu 回归及生产集成测试 → GitHub 构建并推送 GHCR 完整 SHA 镜像 → 受限 SSH 守卫仅部署 toSub2 → 失败回滚。Windows 测试已移除。首次安装服务器守卫与应用发布分开记录；工作流结果未验收前，不得声称部署成功。
- 删除默认仅本地；用户主动勾选才删除绑定的远程账号。须校验编号、邮箱和真实工作区，保留持久化删除标记防止后台重新创建；明确提醒 Spark 影子账号的级联影响，部分失败在当前弹窗显示具体账号与下一步操作。累计扣费按该账号现存历史日志的用户实际扣费统计，读取失败不可展示为零。
- 当前镜像 `tosub2:8548397-server-v3`，生产 `/opt/tosub2/.env` 已启用自动重新授权；2026-10-23 21:10（北京时间）账号 212 完成真实自动登录回写并恢复调度，旧重复记录 215 保留并暂停。备份 `/opt/tosub2/backups/reauth-server-v3` 含敏感资料，不打印或提交。
- 401 自动重新授权由 `TOSUB2_AUTO_REAUTH=true` 开启；只处理已绑定的 OpenAI OAuth 母账号，每分钟检查、间隔至少 15 分钟、每账号滚动 24 小时最多 3 次。验证码/封禁/缺少凭据在页面显示，不绕过人工验证。
- 工作区身份取 OAuth 令牌中的 `https://api.openai.com/auth.chatgpt_account_id`，禁止使用 `sid` / `authsess_...`。回写复用本项目 `apply-oauth-credentials` 接口清理令牌缓存；401 恢复后重新启用原账号调度，不覆盖分组、代理或额度。
- 已同步文件摘要不变时仍每分钟核验绑定。旧 `authsess_` 只在编号、邮箱、令牌工作区及持久化同步记录一致时，通过现有 `bulk-update` 接口合并工作区元数据；不得重放旧令牌、清除现有错误或改变调度。失败与重启必须保留成功摘要，缺少可信记录时显示具体原因并停止修改。
- 密码、OAuth、TOTP、集成密钥不写入日志或仓库。服务器密钥仅在 `/opt/tosub2/secrets`；本机入口密码位于 `/Users/lifengdem1pro/.codex/credentials/tosub2/console.password`，禁止直接打印。
- SSH 运维入口：`/Users/lifengdem1pro/.codex/credentials/sub2api-vultr/ssh.sh '<命令>'`。不修改其他应用的容器或现有反向代理站点。
