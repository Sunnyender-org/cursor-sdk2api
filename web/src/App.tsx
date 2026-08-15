import { useEffect, useMemo, useState } from "react";
import { getAccount, getHealth, getModels, runPrompt } from "./api";
import { BFTheme, type BFThemeTone } from "./bflabs/BFTheme";
import { Button } from "./bflabs/Button";
import { StatusTag } from "./bflabs/StatusTag";
import type { AccountPayload, HealthPayload, ModelsPayload, Protocol } from "./types";

type Language = "en" | "zh";
type LoadState = "idle" | "loading" | "ready" | "error";

const COPY = {
  en: {
    console: "Operator console",
    overview: "Runtime overview",
    connection: "Connect this browser tab",
    connectionHelp: "The key stays in memory only. Reloading or closing this tab clears it.",
    key: "Gateway or Cursor API key",
    connect: "Load account and models",
    connected: "Connected",
    models: "Model catalog",
    connectFirst: "Connect this tab to read the official SDK model catalog.",
    noModels: "No models returned by the official SDK catalog.",
    account: "Account surface",
    partial: "Cursor's official SDK did not return spending or limits for this credential.",
    playground: "Protocol playground",
    prompt: "Prompt",
    run: "Run request",
    running: "Running",
    stream: "Stream response",
    output: "Event output",
    emptyOutput: "Run a request to inspect the protocol response.",
    integrations: "Connection recipes",
    copy: "Copy",
    copied: "Copied",
    language: "中文",
    light: "Light",
    dark: "Dark",
    ready: "Ready",
    unavailable: "Unavailable",
    loading: "Loading",
    proxy: "Proxy",
    direct: "Direct",
    sdk: "SDK",
    protocols: "Protocols",
    model: "Model",
    keyName: "Key name",
    identity: "Identity",
    notReturned: "Not returned",
    notConnected: "Connect this tab to inspect account data.",
    moreModels: "more models available",
  },
  zh: {
    console: "运维控制台",
    overview: "运行概览",
    connection: "连接当前浏览器标签页",
    connectionHelp: "密钥只保存在内存中，刷新或关闭标签页后即清除。",
    key: "网关或 Cursor API Key",
    connect: "读取账号与模型",
    connected: "已连接",
    models: "模型目录",
    connectFirst: "连接当前标签页后读取官方 SDK 模型目录。",
    noModels: "官方 SDK 模型目录没有返回模型。",
    account: "账号信息",
    partial: "Cursor 官方 SDK 没有为此凭据返回花费或额度。",
    playground: "协议测试台",
    prompt: "提示词",
    run: "发起请求",
    running: "请求中",
    stream: "流式响应",
    output: "事件输出",
    emptyOutput: "发起请求后在这里查看协议响应。",
    integrations: "连接配置",
    copy: "复制",
    copied: "已复制",
    language: "English",
    light: "浅色",
    dark: "深色",
    ready: "就绪",
    unavailable: "不可用",
    loading: "加载中",
    proxy: "代理",
    direct: "直连",
    sdk: "SDK",
    protocols: "协议",
    model: "模型",
    keyName: "Key 名称",
    identity: "身份",
    notReturned: "未返回",
    notConnected: "连接当前标签页后查看账号信息。",
    moreModels: "个其他可用模型",
  },
} as const;

export function App() {
  const [language, setLanguage] = useState<Language>("en");
  const [tone, setTone] = useState<BFThemeTone>("light");
  const [health, setHealth] = useState<HealthPayload>();
  const [healthError, setHealthError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connectionState, setConnectionState] = useState<LoadState>("idle");
  const [connectionError, setConnectionError] = useState("");
  const [models, setModels] = useState<ModelsPayload>();
  const [account, setAccount] = useState<AccountPayload>();
  const [protocol, setProtocol] = useState<Protocol>("messages");
  const [selectedModel, setSelectedModel] = useState("");
  const [prompt, setPrompt] = useState("Reply with a short status check for this gateway.");
  const [stream, setStream] = useState(true);
  const [output, setOutput] = useState("");
  const [runState, setRunState] = useState<LoadState>("idle");
  const [recipe, setRecipe] = useState<"claude" | "openai" | "newapi">("claude");
  const [copied, setCopied] = useState(false);
  const t = COPY[language];

  useEffect(() => {
    void getHealth()
      .then(setHealth)
      .catch((error: unknown) => setHealthError(messageOf(error)));
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);

  useEffect(() => {
    if (!selectedModel && models?.data[0]?.id) setSelectedModel(models.data[0].id);
  }, [models, selectedModel]);

  const capabilities = useMemo(() => {
    if (!health) return [];
    return Object.entries(health.capabilities)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name.replaceAll("_", " "));
  }, [health]);

  const connect = async () => {
    if (!apiKey.trim()) {
      setConnectionError("Enter an API key for this tab");
      setConnectionState("error");
      return;
    }
    setConnectionState("loading");
    setConnectionError("");
    setModels(undefined);
    setAccount(undefined);
    setSelectedModel("");
    try {
      const [nextModels, nextAccount] = await Promise.all([
        getModels(apiKey.trim()),
        getAccount(apiKey.trim()),
      ]);
      setModels(nextModels);
      setAccount(nextAccount);
      setConnectionState("ready");
    } catch (error) {
      setModels(undefined);
      setAccount(undefined);
      setSelectedModel("");
      setConnectionError(messageOf(error));
      setConnectionState("error");
    }
  };

  const run = async () => {
    if (!apiKey.trim() || !selectedModel || !prompt.trim()) return;
    setRunState("loading");
    setOutput("");
    try {
      await runPrompt({
        apiKey: apiKey.trim(),
        protocol,
        model: selectedModel,
        prompt: prompt.trim(),
        stream,
        onChunk: setOutput,
      });
      setRunState("ready");
    } catch (error) {
      setOutput(messageOf(error));
      setRunState("error");
    }
  };

  const origin = window.location.origin;
  const snippets = {
    claude: `ANTHROPIC_BASE_URL=${origin}\nANTHROPIC_AUTH_TOKEN=<your-key>\nclaude`,
    openai: `from openai import OpenAI\nclient = OpenAI(base_url="${origin}/v1", api_key="<your-key>")`,
    newapi: `Base URL: ${origin}\nAPI key: <your-key>\nModels: GET ${origin}/v1/models`,
  };

  const copySnippet = async () => {
    try {
      await copyText(snippets[recipe]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const identity = account?.identity;
  const identityName = [identity?.first_name, identity?.last_name].filter(Boolean).join(" ");

  return (
    <BFTheme tone={tone} className="console-shell" lang={language}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="topbar">
        <a className="brand" href="/console/" aria-label="cursor-sdk2api operator console">
          <BfMark />
          <span>
            <strong>cursor-sdk2api</strong>
            <small>{t.console}</small>
          </span>
        </a>
        <div className="topbar__actions">
          <button className="text-control" type="button" aria-label="Change language" onClick={() => setLanguage(language === "en" ? "zh" : "en")}>
            <span className="control-label">{t.language}</span>
            <span className="control-short" aria-hidden="true">{language === "en" ? "中" : "EN"}</span>
          </button>
          <button className="text-control" type="button" aria-label={tone === "light" ? t.dark : t.light} onClick={() => setTone(tone === "light" ? "dark" : "light")}>
            <span className="control-label">{tone === "light" ? t.dark : t.light}</span>
            <span className="control-short" aria-hidden="true">◐</span>
          </button>
          <StatusTag tone={health?.status === "ok" ? "success" : healthError ? "danger" : "progress"}>
            {health?.status === "ok" ? t.ready : healthError ? t.unavailable : t.loading}
          </StatusTag>
        </div>
      </header>

      <main id="main-content" className="workspace">
        <section className="status-band" aria-labelledby="overview-title">
          <div className="status-band__lead">
            <p className="eyebrow">01 / {t.overview}</p>
            <h1 id="overview-title">
              {healthError || health?.status === "not_ready"
                ? t.unavailable
                : health?.readiness.accepting_sessions
                  ? t.ready
                  : t.loading}
            </h1>
            <p>{healthError || `${health?.service ?? "cursor-sdk2api"} · ${health?.runtime ?? "local"}`}</p>
          </div>
          <dl className="status-grid">
            <StatusMetric label={t.sdk} value={health?.sdk_version ?? "…"} />
            <StatusMetric label={t.proxy} value={health ? (health.network.proxy_configured ? t.proxy : t.direct) : "…"} />
            <StatusMetric label={t.protocols} value={health ? (health.capabilities.chat_completions ? "Messages + Chat" : "Messages") : "…"} />
            <StatusMetric label="Instance" value={health?.instance_id?.slice(0, 12) ?? "…"} />
          </dl>
        </section>

        <div className="workspace-grid">
          <aside className="connection-rail" aria-labelledby="connection-title">
            <p className="eyebrow">02 / Access</p>
            <h2 id="connection-title">{t.connection}</h2>
            <p className="section-copy">{t.connectionHelp}</p>
            <label className="field-label" htmlFor="api-key">{t.key}</label>
            <input
              id="api-key"
              className="text-input"
              type="password"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setApiKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void connect();
              }}
              placeholder="cursor_…"
            />
            <Button variant="accent" loading={connectionState === "loading"} onClick={() => void connect()}>
              {connectionState === "ready" ? t.connected : t.connect}
            </Button>
            {connectionError ? <p className="inline-error" role="alert">{connectionError}</p> : null}

            <div className="account-block">
              <div className="section-row">
                <h3>{t.account}</h3>
                {account ? <StatusTag tone={account.status === "ok" ? "success" : "neutral"}>{account.status}</StatusTag> : null}
              </div>
              {account ? (
                <dl className="detail-list">
                  <Detail label={t.identity} value={identityName || identity?.user_id || t.notReturned} />
                  <Detail label={t.keyName} value={identity?.api_key_name || t.notReturned} />
                  <Detail label="Spending" value={account.capabilities.spending ? "Available" : t.notReturned} />
                  <Detail label="Limits" value={account.capabilities.limits ? "Available" : t.notReturned} />
                </dl>
              ) : (
                <p className="quiet-note">{connectionState === "loading" ? t.loading : t.notConnected}</p>
              )}
              {account?.status === "partial" ? <p className="quiet-note">{t.partial}</p> : null}
            </div>
          </aside>

          <div className="main-stack">
            <section className="model-section" aria-labelledby="models-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">03 / Catalog</p>
                  <h2 id="models-title">{t.models}</h2>
                </div>
                {models ? <StatusTag tone={models.status === "ok" ? "success" : "neutral"}>{models.status}</StatusTag> : null}
              </div>
              {models?.data.length ? (
                <div className="model-list" role="list">
                  {models.data.slice(0, 12).map((model, index) => (
                    <button
                      type="button"
                      className="model-row"
                      data-selected={selectedModel === model.id}
                      aria-pressed={selectedModel === model.id}
                      key={model.id}
                      onClick={() => setSelectedModel(model.id)}
                    >
                      <span className="model-row__index">{String(index + 1).padStart(2, "0")}</span>
                      <span>
                        <strong>{model.display_name || model.id}</strong>
                        <small>{model.id}</small>
                      </span>
                      <span className="model-row__params">{model.parameters?.length ?? 0} params</span>
                    </button>
                  ))}
                  {models.data.length > 12 ? (
                    <p className="quiet-note model-remainder">+{models.data.length - 12} {t.moreModels}</p>
                  ) : null}
                </div>
              ) : (
                <p className="empty-state">
                  {connectionState === "loading"
                    ? t.loading
                    : connectionState === "ready"
                      ? t.noModels
                      : t.connectFirst}
                </p>
              )}
            </section>

            <section className="playground" aria-labelledby="playground-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">04 / Request</p>
                  <h2 id="playground-title">{t.playground}</h2>
                </div>
                <div className="protocol-switch" role="group" aria-label="Protocol">
                  <button type="button" data-active={protocol === "messages"} aria-pressed={protocol === "messages"} onClick={() => setProtocol("messages")}>Messages</button>
                  <button type="button" data-active={protocol === "chat"} aria-pressed={protocol === "chat"} onClick={() => setProtocol("chat")}>Chat</button>
                </div>
              </div>
              <div className="playground-grid">
                <div className="request-pane">
                  <label className="field-label" htmlFor="model-select">{t.model}</label>
                  <select id="model-select" className="text-input" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                    <option value="" disabled>Select a model</option>
                    {models?.data.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                  </select>
                  <label className="field-label" htmlFor="prompt">{t.prompt}</label>
                  <textarea id="prompt" className="prompt-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
                  <label className="check-row">
                    <input type="checkbox" checked={stream} onChange={(event) => setStream(event.target.checked)} />
                    <span>{t.stream}</span>
                  </label>
                  <Button
                    variant="primary"
                    loading={runState === "loading"}
                    disabled={!apiKey.trim() || !selectedModel || !prompt.trim()}
                    onClick={() => void run()}
                  >
                    {runState === "loading" ? t.running : t.run}
                  </Button>
                </div>
                <div className="output-pane" aria-live="polite">
                  <div className="output-pane__header">
                    <span>{t.output}</span>
                    <code>{protocol === "messages" ? "/v1/messages" : "/v1/chat/completions"}</code>
                  </div>
                  <pre>{output || t.emptyOutput}</pre>
                </div>
              </div>
            </section>

            <section className="recipes" aria-labelledby="recipes-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">05 / Connect</p>
                  <h2 id="recipes-title">{t.integrations}</h2>
                </div>
              </div>
              <div className="recipe-tabs" role="group" aria-label={t.integrations}>
                {(["claude", "openai", "newapi"] as const).map((name) => (
                  <button key={name} type="button" aria-pressed={recipe === name} onClick={() => setRecipe(name)}>
                    {name === "claude" ? "Claude Code" : name === "openai" ? "OpenAI SDK" : "new-api"}
                  </button>
                ))}
              </div>
              <div className="recipe-code">
                <pre>{snippets[recipe]}</pre>
                <Button variant="secondary" size="sm" onClick={() => void copySnippet()}>{copied ? t.copied : t.copy}</Button>
              </div>
            </section>
          </div>
        </div>

        <footer className="footer">
          <span>BF Labs · cursor-sdk2api</span>
          <div>{capabilities.slice(0, 4).join(" · ")}</div>
          <nav aria-label="Project links">
            <a href="https://github.com/Sunnyender-org/cursor-sdk2api" target="_blank" rel="noreferrer">Source</a>
            <a href="https://github.com/Sunnyender-org/cursor-sdk2api/blob/main/docs/SECURITY.md" target="_blank" rel="noreferrer">Security</a>
          </nav>
        </footer>
      </main>
    </BFTheme>
  );
}

function StatusMetric({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function BfMark() {
  return (
    <svg className="brand-mark" aria-hidden="true" viewBox="0 0 1200 700" width="48" height="28">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M0 4H463C570 4 648 82 648 207C648 268 629 318 598 350C634 382 658 432 658 500C658 616 582 700 470 700H0ZM144 160H440C476 160 499 186 499 224C499 253 486 271 463 278H144ZM370 278H445L582 350H428ZM428 350H582L470 422H374ZM374 422H470C493 433 506 458 506 490C506 524 481 550 442 550H144V430H374Z" />
      <path fill="currentColor" d="M556 4H1122L1035 160H680C665 104 622 47 556 4Z" />
      <path fill="currentColor" d="M679 292H1200L1114 444H684C670 414 658 384 650 350C657 328 667 309 679 292Z" />
    </svg>
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy failed");
}
