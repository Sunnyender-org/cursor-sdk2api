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

## 核心能力

- **Claude Code** 走 `/v1/messages`：SSE、工具、并行与多轮续轮、cache usage、resume、token 估算。
- **Grok Build** 走 `/v1/responses`：流式、function tools、续轮、reasoning usage。
- **Codex / Responses 客户端** 走 `/v1/responses`：Responses 协议、function tools、流式。
- **OpenAI SDK** 走 `/v1/chat/completions`：Chat、流式、工具。

- **Claude 1M 模式：** Cursor 实时目录暴露 `context=1m` 时，包括 Sonnet 4.6、Fable 5，网关会把官方 SDK 参数原样转发。
- **客户端原生工具：** 文件、shell、网页和网络工具仍由 Claude Code、Grok 或 Codex 在你的本机工作区执行。
- **一套工具引擎：** 三种协议共用同一个 Cursor SDK Run、并行工具、续轮、replay 和 session coordinator。
- **运维能力：** 实时模型目录、账号身份、Dashboard 额度、账号持久化、Web 控制台、Docker、HTTP(S) 出站代理。
- **已集成 new-api：** 已提供外置部署、渠道模板、compose E2E 和验收 smoke。[直接查看 new-api 接入指南](docs/NEW_API_INTEGRATION.md)。

> Cursor 通路里的 Grok 不提供 xAI 原生 `x_search`。客户端自己的网页和网络搜索仍可作为普通 function tool 使用。

## 快速开始

需要 Node.js 22.19 或更新版本，以及 Cursor User API Key。

```bash
git clone https://github.com/Sunnyender-org/cursor-sdk2api.git
cd cursor-sdk2api
npm ci
npm run build
AUTH_MODE=byok node dist/index.js
```

打开 [http://localhost:8080/console/](http://localhost:8080/console/)，或直接请求 API：

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer $CURSOR_API_KEY"
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
export ANTHROPIC_AUTH_TOKEN="$CURSOR_API_KEY"
export ANTHROPIC_MODEL=claude-sonnet-4-6
claude
```

### Grok Build

```toml
[model.cursor]
name = "cursor-sdk2api"
base_url = "http://127.0.0.1:8080/v1"
api_key = "<cursor-api-key>"
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
env_key = "CURSOR_API_KEY"
```

目前不支持强制依赖 `previous_response_id`、远端 response store 或 OpenAI 托管工具的 Responses 客户端。

## 工具与搜索

客户端工具会通过 MCP 转成 SDK `local.customTools`。模型在 Cursor harness 中选择工具，外层客户端在自己的工作区执行。

- 支持：Claude Code、Grok、Codex 本机工具，包括客户端自带网页或网络搜索。
- 禁用：Cursor ambient shell、read、edit、task、`webSearch`、`webFetch`。
- 当前通路不可用：xAI `x_search`。
- 尚未实现：OpenAI 托管 `web_search`、`file_search`、`computer`。

## 运维

- `/console/`：本地运维控制台
- `/v1/models`：Cursor 实时模型目录
- `/v1/account`：Cursor 身份和当前 Dashboard 用量
- `/health`：能力、SDK 版本和代理传输状态
- `STATE_DIR`：账号、SDK store 和 resume 状态

`v0.1` 是可信单进程 sidecar。账号管理接口没有单独认证，并可能返回已保存的 Cursor Key。请只绑定回环地址，或在外层增加 TLS 和认证代理。

## 验证

确定性测试共 156 项。有日期、已脱敏的真实验收覆盖 Sonnet 4.6、Fable 5、Composer 2.5 和 Grok 4.6 xhigh：[live smoke 回执](docs/evidence/2026-08-15-live-smoke.md)。

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
