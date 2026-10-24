# toSub2 独立部署

## GitHub 自动发布（2026-10-24 配置）

- 修改仓库：`https://github.com/DomenLee/toSub2.git`；本机：`/Users/lifengdem1pro/Documents/students/toSub2`。业务与集成补丁只在本仓库修改，不混入 Sub2API 工作区的其他改动。
- `.github/workflows/deploy.yml` 仅在 `main` 推送或选择 `main` 手动执行时发布。先运行 Ubuntu 回归、生产补丁/前端构建与交互测试，再在 GitHub 构建镜像并以无外网、空数据目录执行真实服务入口集成测试。检查工作流仅使用 Ubuntu，Windows 测试已移除。
- 通过测试的同一个镜像推送到 `ghcr.io/domenlee/tosub2:<完整 main SHA>`，不使用 `latest`。服务器复核远端 main 最新 SHA、OCI 提交标签、运行镜像 ID、健康和新功能 bootstrap；失败保留受限日志并回滚应用配置与旧镜像，不恢复数据库覆盖新写入。
- Actions Secrets：`VULTR_HOST`、`VULTR_DEPLOY_KEY`、`VULTR_KNOWN_HOSTS`。专用部署密钥只允许执行 `/opt/tosub2/bin/deploy-github.sh` 的 `deploy <完整 SHA>` 命令，不允许任意 SSH 命令、转发或交互终端。GHCR 使用工作流短期令牌，临时 Docker 登录配置在部署结束时删除；不保存长期 GitHub 令牌到服务器。
- 服务器入口的首次安装属于单独的运维基础设施配置，不代表应用发布。后续如修改守卫脚本，需单独核对后安装服务器版本，不能仅提交仓库就假设服务器守卫已同步。
- 更新前备份数据库、Compose、环境、旧镜像信息及停机后的 toSub2 数据，保存在 `/opt/tosub2/backups/github-<SHA>-<UTC>`，权限受限，不输出其内容。仅重建 `tosub2` 服务，保留现有 `.env` 与密钥，不重启 Sub2API、数据库、Redis 或其他服务。有进行中任务时拒绝发布，待任务完成后由用户重跑工作流。
- 本次配置后由 GitHub 异步执行发布，结果以 Actions 为准；不把“已推送/已触发”描述成“已成功部署”。下文的 v3 是上线前最后一次核实的手工部署记录，旧的“尚未启用”描述仅代表当时状态。

## 关联账号管理

账号行提供“账号详情”，通过服务端读取已绑定账号详情和 `/api/v1/admin/usage/stats`。页面汇总账号数、当前在线（账号可调度）、待重新授权和需要处理数量，区分待授权、待同步、同步失败、绑定待核对和读取失败。账号保持单行，可复制完整邮箱；桌面默认仅显示下载与更多，移动端卡片可折叠，未选择账号时隐藏批量操作。

概览每 15 秒刷新，任务状态或同步记录变化时立即刷新；请求串行并在卸载或切换时取消。概览不查询历史用量，累计扣费只在详情与删除确认按需读取。配置额度明确展示数据覆盖范围，含不限额账号时不展示误导的有限总额。OAuth 订阅总额度与已用额度当前接口未提供，不以累计扣费代替。扣费为该母账号现存历史日志的 `total_actual_cost`，不是账号成本，不包含已清理日志或影子账号日志，不受账号专用统计接口 90 天范围限制。失败显示“暂不可用”，不伪装成零；管理员密钥与 OAuth 不返回浏览器。

批量添加及关联账号弹窗支持 Escape 关闭、Tab 焦点约束与关闭后焦点恢复，提交期间禁止关闭。桌面与 360/390px 移动布局均需用应用了生产补丁的预览验证，避免仅检查开发入口而遗漏账号详情按钮与同步面板。

批量删除弹窗新增“同时删除 Sub2API 中的关联账号”，默认不勾选，明确提示母账号会级联删除 Spark 影子账号。服务端重新核对账号编号、邮箱、真实工作区及用户确认时的绑定；身份不明、绑定变化或任务仍进行中时拒绝联动删除。远程删除与同步队列串行，删除意图持久化，避免超时或重启后后台重新创建账号。远程成功才清理本地，部分失败在当前弹窗显示邮箱、账号编号和下一步操作；可安全重试。本功能不会自动删除已有重复记录。

本地验证：`npm ci --ignore-scripts && node deploy/server/check.mjs`。隔离容器入口测试为 `repair.integration.mjs` 和 `accounts.integration.mjs`，运行方式见发布工作流；不能将其指向生产数据目录。

## 当前版本

2026-10-23 已部署 `tosub2:8548397-server-v3`（镜像 ID `sha256:48f89b6b24124214de2a54603d2fb5c1745788328e044f91207dd60843fd6247`），源码目录 `/opt/tosub2/releases/8548397-server-v3`。生产 `.env` 已设置 `TOSUB2_AUTO_REAUTH=true`。21:08 自动检测账号 212 的 401 并启动完整登录，21:10 成功回写原记录、清除错误并恢复调度，页面确认 recovered；均为北京时间。旧逻辑误新增的 215 与 212 的真实工作区已核实相同，215 保留但暂停调度，本次没有新增账号。

除首版验证外，已通过运行镜像内的同步、安全、身份与限流测试，以及隔离完整登录回写测试；公网带认证的页面和新增状态提示可用。主应用镜像及启动时间保持不变。旧部署和数据、账号变更前备份位于 `/opt/tosub2/backups/reauth-server-v3`，权限受限，不输出其中凭据。此版本仍为独立服务手工发布，不表示已经启用 GitHub 自动发布。

## 首版状态

2026-10-23 已上线：https://tosub.gptplusch.store 。用户名 `admin`；密码在本机 `/Users/lifengdem1pro/.codex/credentials/tosub2/console.password`，仅当前用户可读，不进入 Git。

- 源码：`DomenLee/toSub2` 的 `main`，首版固定提交 `8548397e89bf80e508eda64a87e0d556d43abc84`。
- 本目录为首版部署补丁；在镜像构建时应用，不直接改动上游工作区源码。
- 镜像：`tosub2:8548397-server-v1`，ID `sha256:71479c703b7fb98109c7566ce9ff1b9f8cd418f5c9a530465ae6a54e95cf980a`。
- 服务器：Vultr 东京 `45.77.27.100`。独立 Compose 项目 `tosub2`，配置 `/opt/tosub2/compose.yaml`，数据 `/opt/tosub2/data`，发布源码 `/opt/tosub2/releases/8548397-server-v1`。
- DNS：Cloudflare `tosub` A 记录 → `45.77.27.100`，Proxied。Caddy 自动签发 HTTPS，转发到 `127.0.0.1:4399`。
- 首版为手工构建部署；尚未提交这些部署文件，也未启用 GitHub Actions 自动发布。后续流水线应从 main 的确定提交构建、测试后更新 toSub2；不得直接部署未通过安全补丁检查的上游。

## 与 Sub2API 的关系

toSub2 独立承担账号登录、验证码、2FA 和重新授权。成功后立即经 Docker 内网请求 `http://sub2api:8080` 的现有账号管理接口；启动时恢复未完成的同步，每 10 秒检查，失败后每分钟重试，并提供页面上的立即重试按钮。

按邮箱和真实工作区匹配非影子账号，已绑定任务优先更新其原账号。工作区来自 OAuth 令牌的 `https://api.openai.com/auth.chatgpt_account_id`，不能使用每次登录会改变的 `sid`。更新调用现有 `apply-oauth-credentials` 接口，保留分组、代理、额度和模型映射，同时使旧令牌缓存失效；401 错误恢复后重新启用原账号调度。全新任务没有匹配时按上游默认值新增（并发 10、优先级 1、倍率 1）；已绑定账号丢失、工作区改变或对应关系不明确时明确报错，不自动新增重复账号。

已成功同步的授权文件即使摘要不变，也会在首次检查及之后每分钟核验远端绑定，立即重试可跳过间隔。历史 `authsess_` 仅在账号编号、邮箱、非影子 OAuth 类型、已同步文件摘要、令牌中的真实工作区与持久化工作区全部一致时自动修复；写入前重新读取，写入后再次核验。修复复用 `POST /api/v1/admin/accounts/bulk-update`，仅合并 `credentials.chatgpt_account_id` 和 `extra` 中的两个工作区字段，保留当前令牌、分组、代理、额度、错误状态和调度状态。历史令牌即使已过期也只用作已同步文件的身份记录，不用于请求或重新回写。API 返回的脱敏令牌不视为凭据缺失。

以持久化的最近成功摘要判断授权文件是否已同步，不依赖当前同步状态；校验失败、接口超时、重启和强制重试均保持只校验/修复元数据，不能转为重放旧令牌。可信记录不足或工作区冲突时停止修改，在账号行、详情及同步面板给出具体原因与下一步操作；旧工作区未修复前仍禁止联动删除。仅新授权文件进入凭据同步流程。迁移与删除共用串行队列，仍受持久化删除标记保护。回归用例见 `binding.test.mjs`，实际服务入口迁移由 `accounts.integration.mjs` 的隔离假数据覆盖。

不修改 Sub2API 业务代码、前端、Compose 或现有密钥；仅连接其已有 `sub2api-trial_production-egress` 网络，复用已存在的管理员集成密钥。该密钥权限较大，只有服务端挂载可读取；不返回浏览器、不写入浏览器本地存储。

## 安全与凭据

- 所有网页/API/下载均先校验独立 HTTP Basic 认证；浏览器 Origin 必须与 HTTPS 域名一致。
- 使用编译后的静态页面，运行镜像移除 Vite/React 构建依赖，不提供开发文件读取接口。
- 强制上游 TLS 证书校验，密码/TOTP/代理资料使用 AES-256-GCM 加密，OAuth 与检查点文件权限 0600。运行时及服务器管理员仍可访问凭据，不代表彻底消除泄露风险。
- 非 root、只读根目录、去除 capabilities，限制 CPU/内存/进程。容器端口仅监听宿主机回环地址。
- `/opt/tosub2/secrets/console-password` 为公网入口密码，`credential-key` 为数据加密密钥，`sub2api-key` 为已有管理员集成密钥。不要输出、提交或随镜像打包这些文件。
- 原生手工推送和号池监控入口继续关闭，统一使用服务端同步及下述受限 401 检测。不会自动修改账号密码。

## 401 自动重新授权

`TOSUB2_AUTO_REAUTH` 默认 `false`；用户确认后在生产 `/opt/tosub2/.env` 设置 `TOSUB2_AUTO_REAUTH=true`，重新创建本服务生效。每分钟检查已由 toSub2 同步且有账号绑定的 OpenAI OAuth 母账号；只对 401 发起完整重新登录。上次登录必须全自动完成，所需密码、2FA 或邮件收码资料必须仍可用。已封禁账号、其他工作区、影子账号和未托管账号不会自动启动。

每账号至少间隔 15 分钟，滚动 24 小时最多 3 次，尝试记录保存在 `/data/repair-state.json`，重启不会重置限流。正在验证、缺少资料、失败及重试上限在同步面板按账号编号显示。新授权生成后若回写失败，只重试回写，不重复登录。后台检测默认关闭，独立测试可以开启；不要把测试脚本运行到生产数据目录。

`8548397-server-v3` 包含 401 检测、真实工作区匹配、OAuth 专用回写和调度恢复。上线前对旧任务只迁移已核实的绑定及工作区元数据，不重新推送已过期的旧令牌；已有重复记录不得直接删除。

## 验证与更新

```bash
node deploy/server/test.mjs
node deploy/server/repair.test.mjs
node deploy/server/identity.test.mjs
docker build -f deploy/server/Dockerfile -t tosub2:<版本> .
docker compose -f /opt/tosub2/compose.yaml config --quiet
docker compose -f /opt/tosub2/compose.yaml up -d --wait --wait-timeout 120
```

每次更新使用新镜像标签，保留旧镜像与 Compose 备份，再更新配置中的 image。安全补丁按精确源码匹配，上游结构变化会停止构建，需要先审查适配。不要修改 Sub2API 的镜像或执行其整栈重启。

已通过的首版验证：本机与镜像内的创建/更新/去重/重试/重启恢复/身份校验、凭据加密与篡改拒绝；公网 HTTPS、匿名 401、认证页面及 JS/CSS、bootstrap；内网账号查询；主应用及所有容器健康。新增 `repair.integration.mjs` 必须在 `--network none`、空 `/data` tmpfs、`--add-host sub2api:127.0.0.1`、`TOSUB2_ISOLATED_TEST=true` 的隔离容器中运行，验证真实生产入口连接模拟服务完成 401 → 重新登录 → 原账号回写 → 调度恢复；不会创建虚假生产账号。

首版 Caddy 变更前备份：`/opt/tosub2/backups/Caddyfile.before`。仅在没有后续他人配置变更时才可整体恢复，否则只移除 tosub 站点块并 validate/reload。停止本服务可执行 `docker compose -f /opt/tosub2/compose.yaml stop`；不要删除数据或加密密钥。
