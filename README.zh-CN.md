<p align="center">
  <img src=".github/logo.svg" width="96" alt="cursor-sdk2api Logo">
</p>

<h1 align="center">cursor-sdk2api</h1>

<p align="center">
  把官方 Cursor SDK 接到你的 Agent 已经会用的 API 上。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/Sunnyender-org/cursor-sdk2api/actions/workflows/ci.yml">CI</a> ·
  <a href="LICENSE">MIT</a>
</p>

`cursor-sdk2api` 把公开发布的 [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) 转成 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses API。底层直接使用 Cursor 官方 Agent harness，不抓浏览器 Cookie，不逆向私有传输，也不套 CLI 登录态。

<p align="center">
  <img src="docs/assets/console-accounts.jpg" alt="cursor-sdk2api 多账号运维控制台">
</p>

## 核心能力

- **Claude Code** 走 `/v1/messages`：SSE、工具、并行与多轮续轮、cache usage、resume、token 估算。
- **Grok Build** 走 `/v1/responses`：流式、function tools、续轮、reasoning usage。
- **Codex / Responses 客户端** 走 `/v1/responses`：Responses 协议、function tools、流式。
- **OpenAI SDK** 走 `/v1/chat/completions`：Chat、流式、工具。

- **Claude 1M 模式：** Cursor 实时目录暴露 `context=1m` 时，包括 Sonnet 4.6、Fable 5，网关会把官方 SDK 参数原样转发。
- **客户端原生工具：** 文件、shell、网页和网络工具仍由 Claude Code、Grok 或 Codex 在你的本机工作区执行。
- **一套工具引擎：** 三种协议共用同一个 Cursor SDK Run、并行工具、续轮、replay 和 session coordinator。带完整 transcript 的普通下一轮会复用同一个 durable Agent，并且只 `send` 当前用户回合。
- **一把网关 Key，多账号共用：** Cursor 账号池持久化、按模型 round-robin、SDK 陈旧登录态恢复、语义输出前账号故障转移、Dashboard 额度、Web 控制台和 Docker。
- **续轮冷恢复：** 客户端携带完整 transcript 时，可以重建过期或迁移的工具轮；已经执行过的同一工具由网关内部回放结果，不重复产生副作用。
- **已集成 new-api：** 已提供外置部署、渠道模板、compose E2E 和验收 smoke。[直接查看 new-api 接入指南](docs/NEW_API_INTEGRATION.md)。

> Cursor 通路里的 Grok 不提供 xAI 原生 `x_search`。客户端自己的网页和网络搜索仍可作为普通 function tool 使用。

## 快速开始

需要 Node.js 22.19 或更新版本、一把网关 Key，以及至少一个用于导入的 Cursor User API Key。

```bash
git clone https://github.com/Sunnyender-org/cursor-sdk2api.git
cd cursor-sdk2api
npm ci
npm run build
AUTH_MODE=managed GATEWAY_ACCESS_KEY='replace-me' node dist/index.js
```

打开 [http://localhost:8080/console/](http://localhost:8080/console/)，导入一个或多个 Cursor 账号，之后所有账号统一使用同一把网关 Key：

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer $GATEWAY_ACCESS_KEY"
```

Docker：

```bash
docker compose up --build
```

Cursor 需要代理时，设置 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`。网关会把两条 SDK 数据通路一起接管。SOCKS 和 PAC 会 fail closed。

## 客户端配置

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN="$GATEWAY_ACCESS_KEY"
export ANTHROPIC_MODEL=claude-sonnet-4-6
claude
```

### Grok Build

```toml
[model.cursor]
name = "cursor-sdk2api"
base_url = "http://127.0.0.1:8080/v1"
api_key = "<gateway-key>"
model = "grok-4.6"
api_backend = "responses"
```

### Codex

```toml
model = "composer-2.5"
model_provider = "cursor-sdk2api"

[model_providers.cursor-sdk2api]
name = "cursor-sdk2api"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "GATEWAY_ACCESS_KEY"
```

目前不支持强制依赖 `previous_response_id`、远端 response store 或 OpenAI 托管工具的 Responses 客户端。

## 工具与搜索

客户端工具会通过 MCP 转成 SDK `local.customTools`。模型在 Cursor harness 中选择工具，外层客户端在自己的工作区执行。

- 支持：Claude Code、Grok、Codex 本机工具，包括客户端自带网页或网络搜索。
- 禁用：Cursor ambient shell、read、edit、task。托管 `webSearch` / `webFetch` 默认关闭；仅当 `HOSTED_SEARCH_MODE=auto` 且客户端发送无过滤的 live web_search 时启用。filters、required/named、Chat `web_search_options` 和 `x_search` 仍 fail closed。
- 当前通路不可用：xAI `x_search`。
- 尚未实现：OpenAI 托管 `web_search`、`file_search`、`computer`。

## 运维

- `/console/`：本地运维控制台
- `/v1/models`：Cursor 实时模型目录
- `/v1/account`：managed 模式下所有 Cursor 账号身份与当前 Dashboard 用量
- `/health`：能力、SDK 版本和代理传输状态
- `STATE_DIR`：账号、SDK store 和 resume 状态

Managed 模式沿用 CPA 的客户端 Key 与上游凭据分离方式：客户端只拿到 `GATEWAY_ACCESS_KEY`，导入的 Cursor Key 留在网关账号池。新会话按模型 round-robin；正常续轮固定原账号，尚未产生语义输出时允许一次备用账号重试。原账号或 SDK 会话丢失时，只要 transcript 完整且自洽，网关可安全冷恢复。BYOK 仅作为可信单用户 sidecar 的兼容模式保留。

`v0.1` 是可信单进程 sidecar。账号管理接口没有单独认证；导入的 Cursor Key 会保存在仅 Owner 可读的状态文件中，导入后不会再返回给浏览器。随附 compose 已把控制台绑定到本机回环；任何公网反代都必须认证并限制 `/console/` 与 `/v0/management/*`。

## 验证

确定性测试共 189 项。最新脱敏回执证明 Sonnet 4.6 与 Grok 4.6 xhigh 的持久化恢复和完整 transcript 冷恢复：[恢复 live smoke](docs/evidence/2026-08-19-beefapi-sync-live-smoke.md)。较早的四模型回执还覆盖 Fable 5 与 Composer 2.5：[四模型回执](docs/evidence/2026-08-15-live-smoke.md)。

```bash
npm run typecheck
npm test
npm run build
```

## 文档

- [协议兼容](docs/PROTOCOL_COMPATIBILITY.md)
- [部署](docs/DEPLOYMENT.md)
- [架构](docs/ARCHITECTURE.md)
- [安全](docs/SECURITY.md)
- [new-api 接入](docs/NEW_API_INTEGRATION.md)

MIT 许可。`@cursor/sdk` 仍受其自身许可证与 Cursor 服务条款约束。本项目与 Cursor / Anysphere 无官方关联。
