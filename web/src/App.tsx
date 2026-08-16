import { useEffect, useMemo, useState } from "react";
import { addManagedAccount, getAccount, getHealth, getManagedAccounts, getModels, removeManagedAccount, runPrompt } from "./api";
import { go, hrefFor, readRoute, type Route } from "./nav";
import { RailNav } from "./RailNav";
import { AccountDetailPage } from "./pages/AccountDetailPage";
import { AccountsPage } from "./pages/AccountsPage";
import { ConnectPage } from "./pages/ConnectPage";
import type { RecipeName } from "./recipes";
import { HomePage, type HomeCopy } from "./pages/HomePage";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { QuotaPage } from "./pages/QuotaPage";
import { BFTheme } from "./bflabs/BFTheme";
import { Button } from "./bflabs/Button";
import { StatusTag } from "./bflabs/StatusTag";
import type { RosterItem } from "./roster";
import type { HealthPayload, Protocol } from "./types";

type Language = "en" | "zh";
type LoadState = "idle" | "loading" | "ready" | "error";

const COPY = {
  en: {
    skip: "Skip to content",
    brand: "BF Labs",
    product: "cursor-sdk2api",
    groupOperate: "General",
    groupGateway: "Access",
    navHome: "Home",
    navStart: "Quick start",
    navAccounts: "Accounts",
    navQuota: "Quota",
    navPlay: "Playground",
    navHomeMeta: "Runtime and API URLs",
    navStartMeta: "Client recipes",
    navAccountsMeta: "Persistent credentials",
    navQuotaMeta: "Cursor dashboard usage",
    navPlayMeta: "Messages / Chat / Responses",
    consoleTag: "Local console",
    ready: "Ready",
    unavailable: "Down",
    loading: "Loading",
    proxy: "Proxy",
    direct: "Direct",
    language: "中文",
    dark: "Dark",
    light: "Light",
    source: "Source",
    security: "Security",
    home: {
      kicker: "Runtime overview",
      title: "Overview",
      dashTitle: "Home",
      status: "Run state",
      net: "Network",
      api: "Protocols",
      version: "Version",
      instance: "Instance",
      runtime: "Runtime",
      fleet: "Credentials",
      controlTitle: "Runtime",
      apiTitle: "API URL",
      process: "Process",
      processUp: "Up",
      processDown: "Down",
      refresh: "Refresh",
      refreshing: "Refreshing",
      firstKey: "First key",
      noKey: "Add a Cursor key first",
      localUrl: "Local URL",
      reachable: "Reachable",
      waitingLink: "Waiting",
      messagesHint: "Claude Code · Messages",
      chatHint: "OpenAI SDK · Chat Completions",
      responsesHint: "Grok Build · Responses",
      verdictGood: "Steady",
      verdictWarn: "Needs attention",
      verdictIdle: "Waiting for keys",
      verdictOffline: "Waiting to connect",
      verdictGoodBody: "Local gateway is ready. Quota uses Cursor Dashboard current-period data.",
      verdictWarnBody: "At least one key failed its probe. Open Accounts to retest.",
      verdictIdleBody: "Process is up. Open Accounts and add a Cursor key to start probing.",
      verdictOfflineBody: "The console cannot reach /health on this origin.",
      nextKicker: "Next",
      nextTitle: "Where to go next",
      nextQuota: "Quota",
      nextQuotaDesc: "Totals first, then each account returned by Cursor Dashboard.",
      nextAuth: "Accounts",
      nextAuthDesc: "Add, probe, and remove persistent Cursor credentials.",
      nextPlay: "Playground",
      nextPlayDesc: "Send one Messages, Chat, or Responses request through the gateway.",
      nextStart: "Quick start",
      nextStartDesc: "Copy the local origin and client recipes.",
      quickStart: "Quick start",
      quotaPageKicker: "Total then detail",
      quotaPageTitle: "Quota",
      quotaDesc: "Current Cursor billing-cycle usage from the same User API Key. Empty cells mean the dashboard endpoint was unavailable.",
      manage: "Accounts",
      authTitle: "Accounts",
      authMeta: "{total} credentials · {ok} probed · {bad} failed",
      tryPlay: "Playground",
      origin: "Gateway",
      copy: "Copy",
      copied: "Copied",
      totalAccounts: "Accounts",
      tested: "Tested",
      failed: "failed",
      quotaKnown: "Quota returned",
      quotaHint: "Cursor Dashboard current period. No invented totals.",
      fableOnShort: "on",
      fableOffShort: "off",
      breakdown: "Per account",
      testAll: "Test all",
      noAccounts: "No persistent Cursor accounts yet.",
      quotaMissing: "Not returned",
      fableOn: "On",
      fableOff: "Off",
      fableUnknown: "Untested",
      testing: "Testing",
      test: "Test",
      testFail: "Failed",
      open: "Open",
      headers: ["Account", "Quota", "Fable 5", "Probe"] as [string, string, string, string],
      add: "Add",
      adding: "Adding",
      keyPlaceholder: "Cursor API key",
      keyHelp: "Stored by the gateway in STATE_DIR/auths with owner-only file permissions.",
      remove: "Remove",
    },
    detail: {
      missing: "Account not found",
      back: "All accounts",
      test: "Test",
      testing: "Testing",
      use: "Use in playground",
      quota: "Quota",
      quotaMissing: "Cursor Dashboard usage unavailable",
      quotaOpen: "Open Cursor usage",
      fableOn: "In catalog",
      fableOff: "Not enabled",
      fableUnknown: "Untested",
      fableHelp: "Privacy Mode and Team accounts must approve Fable 5 data retention in the Cursor Dashboard before the model appears.",
      fableOpen: "Enable Fable 5 in Cursor",
      fableDocs: "Docs",
      models: "Catalog",
      noModels: "Official catalog returned no models.",
      cursorUsage: "https://cursor.com/dashboard",
    },
    play: {
      title: "Protocol playground",
      pick: "Account",
      prompt: "Prompt",
      send: "Send",
      sending: "Sending",
      stream: "Stream",
      events: "Event output",
      emptyOutput: "Send a request to inspect the protocol response.",
      waiting: "Add an account first",
      accounts: "Go to accounts",
    },
    connect: {
      title: "Quick start",
      origin: "Gateway",
      copy: "Copy",
      copied: "Copied",
      recipes: "Client recipes",
      routeTitle: "Client to endpoint",
      routeClient: "Client",
      routeEndpoint: "Endpoint",
      routeNote: "Why",
      workspaceTitle: "Local files",
      workspaceBody:
        "Grok Build and Claude Code edit files with their own local tools in your project directory. This gateway only runs the model. Cursor SDK uses an empty workspace, so the model may emit that absolute path. Use a relative path or your project path. A BeefAPI Cursor channel is the same split: remote inference, local tools.",
    },
    keyNeeded: "Paste a Cursor API key first.",
  },
  zh: {
    skip: "跳到主要内容",
    brand: "BF Labs",
    product: "cursor-sdk2api",
    groupOperate: "通用",
    groupGateway: "接入",
    navHome: "首页",
    navStart: "快速开始",
    navAccounts: "账号",
    navQuota: "配额",
    navPlay: "协议试跑",
    navHomeMeta: "运行控制和 API 地址",
    navStartMeta: "客户端配方",
    navAccountsMeta: "持久化凭证",
    navQuotaMeta: "官方限额",
    navPlayMeta: "Messages / Chat / Responses",
    consoleTag: "本机控制台",
    ready: "就绪",
    unavailable: "不可用",
    loading: "加载中",
    proxy: "代理",
    direct: "直连",
    language: "EN",
    dark: "深色",
    light: "浅色",
    source: "源码",
    security: "安全",
    home: {
      kicker: "运行总览",
      title: "概览",
      dashTitle: "首页",
      status: "运行状态",
      net: "网络",
      api: "协议",
      version: "版本",
      instance: "实例",
      runtime: "运行配置",
      fleet: "凭证状态",
      controlTitle: "运行控制",
      apiTitle: "API URL",
      process: "进程",
      processUp: "已启动",
      processDown: "未连接",
      refresh: "刷新状态",
      refreshing: "刷新中",
      firstKey: "第一个密钥",
      noKey: "先加入一把 Cursor Key",
      localUrl: "本机 URL",
      reachable: "可连接",
      waitingLink: "等待连接",
      messagesHint: "Claude Code · Messages",
      chatHint: "OpenAI SDK · Chat Completions",
      responsesHint: "Grok Build · Responses",
      verdictGood: "运行平稳",
      verdictWarn: "需要留意",
      verdictIdle: "静候账号",
      verdictOffline: "等待连接",
      verdictGoodBody: "本机网关已就绪。额度来自 Cursor Dashboard 当前周期。",
      verdictWarnBody: "至少一把 Key 测通失败。去账号页重测。",
      verdictIdleBody: "进程已起来。去账号页加入 Cursor Key 即可测通。",
      verdictOfflineBody: "控制台连不上这个 origin 的 /health。",
      nextKicker: "下一步",
      nextTitle: "接下来去哪里",
      nextQuota: "配额",
      nextQuotaDesc: "先看合计，再看 Cursor Dashboard 返回的每个账号。",
      nextAuth: "账号",
      nextAuthDesc: "加入、测通、移除服务端持久化的 Cursor Key。",
      nextPlay: "协议试跑",
      nextPlayDesc: "用 Messages / Chat / Responses 打一条真实请求。",
      nextStart: "快速开始",
      nextStartDesc: "复制本机 origin 和客户端配方。",
      quickStart: "快速开始",
      quotaPageKicker: "先总后分",
      quotaPageTitle: "配额",
      quotaDesc: "使用同一把 Cursor User API Key 查询当前计费周期用量。空单元格表示 Dashboard 额度接口暂不可用。",
      manage: "账号",
      authTitle: "账号",
      authMeta: "{total} 个凭证 · {ok} 个测通 · {bad} 个异常",
      tryPlay: "协议试跑",
      origin: "本机网关",
      copy: "复制",
      copied: "已复制",
      totalAccounts: "账号",
      tested: "已测通",
      failed: "失败",
      quotaKnown: "额度已返回",
      quotaHint: "Cursor Dashboard 当前周期，不编造额度。",
      fableOnShort: "已开",
      fableOffShort: "未开",
      breakdown: "分账号",
      testAll: "全部测通",
      noAccounts: "还没有持久化的 Cursor 账号。",
      quotaMissing: "未返回",
      fableOn: "已开",
      fableOff: "未开",
      fableUnknown: "未测",
      testing: "测试中",
      test: "测试",
      testFail: "失败",
      open: "打开",
      headers: ["账号", "额度", "Fable 5", "测通"] as [string, string, string, string],
      add: "加入",
      adding: "加入中",
      keyPlaceholder: "Cursor API Key",
      keyHelp: "账号由网关写入 STATE_DIR/auths，并使用仅属主可读写的文件权限。",
      remove: "移除",
    },
    detail: {
      missing: "找不到这个账号",
      back: "全部账号",
      test: "测试",
      testing: "测试中",
      use: "去试跑",
      quota: "额度",
      quotaMissing: "Cursor Dashboard 用量不可用",
      quotaOpen: "打开 Cursor 用量",
      fableOn: "目录已含",
      fableOff: "未开启",
      fableUnknown: "未检测",
      fableHelp: "若账号开了 Privacy Mode，或属于 Team / Enterprise，需要先在 Cursor Dashboard 批准 Fable 5 数据保留政策，模型才会出现在官方目录。",
      fableOpen: "去 Cursor 打开 Fable 5",
      fableDocs: "说明",
      models: "模型目录",
      noModels: "官方目录没有返回模型。",
      cursorUsage: "https://cursor.com/dashboard",
    },
    play: {
      title: "协议试跑",
      pick: "账号",
      prompt: "提示词",
      send: "发送",
      sending: "发送中",
      stream: "流式",
      events: "事件输出",
      emptyOutput: "发送请求后在这里查看协议响应。",
      waiting: "先加入账号",
      accounts: "去账号页",
    },
    connect: {
      title: "快速开始",
      origin: "本机网关",
      copy: "复制",
      copied: "已复制",
      recipes: "连接配方",
      routeTitle: "客户端对应端点",
      routeClient: "客户端",
      routeEndpoint: "端点",
      routeNote: "说明",
      workspaceTitle: "本地文件",
      workspaceBody:
        "Grok Build / Claude Code 改文件用的是它们自己的本机工具，工作区是你的项目目录。这个网关只提供模型推理。Cursor SDK 的 cwd 是空目录，所以模型有时会吐出网关绝对路径。写相对路径或你的项目路径就能改本地文件。BeefAPI 的 Cursor 通路也是同一件事：远端推理，本地工具。",
    },
    keyNeeded: "先粘贴一把 Cursor Key。",
  },
} as const;

function initialLanguage(): Language {
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function App() {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [tone, setTone] = useState<"light" | "dark">("light");
  const [route, setRoute] = useState<Route>(readRoute);
  const [health, setHealth] = useState<HealthPayload>();
  const [healthError, setHealthError] = useState("");
  const [refreshingHealth, setRefreshingHealth] = useState(false);
  const [roster, setRoster] = useState<RosterItem[]>([]);
  const [draftKey, setDraftKey] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("messages");
  const [selectedModel, setSelectedModel] = useState("");
  const [prompt, setPrompt] = useState("Reply with a short status check for this gateway.");
  const [stream, setStream] = useState(true);
  const [output, setOutput] = useState("");
  const [runState, setRunState] = useState<LoadState>("idle");
  const [recipe, setRecipe] = useState<RecipeName>("claude");
  const [copied, setCopied] = useState("");
  const t = COPY[language];
  const origin = window.location.origin;
  const active = roster.find((item) => item.id === activeId);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshHealth = async () => {
    setRefreshingHealth(true);
    try {
      setHealth(await getHealth());
      setHealthError("");
    } catch (error: unknown) {
      setHealthError(messageOf(error));
    } finally {
      setRefreshingHealth(false);
    }
  };

  useEffect(() => {
    void refreshHealth();
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.title = `${t.product} · ${pageLabelFor(route.page, t)}`;
  }, [language, route.page, t]);

  useEffect(() => {
    if (!selectedModel && active?.models?.data[0]?.id) setSelectedModel(active.models.data[0].id);
  }, [active, selectedModel]);

  const protocolSummary = useMemo(() => {
    if (!health) return "…";
    const supported = ["Messages"];
    if (health.capabilities.chat_completions === true) supported.push("Chat");
    if (health.capabilities.responses === true) supported.push("Responses");
    return supported.join(" + ");
  }, [health]);

  const snippets: Record<RecipeName, string> = {
    claude: `ANTHROPIC_BASE_URL=${origin}\nANTHROPIC_AUTH_TOKEN=<account-key>\nANTHROPIC_MODEL=claude-sonnet-4-6\nclaude`,
    grok: `[models]\ndefault = "cursor-gw"\n\n[model.cursor-gw]\nname = "cursor-sdk2api"\nbase_url = "${origin}/v1"\napi_key = "<account-key>"\nmodel = "grok-4.6"\napi_backend = "responses"\n\n# Isolated: GROK_HOME=/path/to/grok_home grok --model cursor-gw`,
    openai: `from openai import OpenAI\nclient = OpenAI(base_url="${origin}/v1", api_key="<account-key>")`,
    newapi: `Base URL: ${origin}\nAPI key: <account-key>\nAnthropic upstream: ${origin}\nOpenAI upstream: ${origin}/v1`,
  };
  const clientRoutes = language === "zh"
    ? [
        { client: "Claude Code", endpoint: "POST /v1/messages", note: "ANTHROPIC_BASE_URL，不要走 Chat" },
        { client: "Grok Build", endpoint: "POST /v1/responses", note: "api_backend=responses；若带 previous_response_id 被 422，再退回 chat_completions" },
        { client: "OpenAI SDK", endpoint: "POST /v1/chat/completions", note: "base_url 指到 /v1" },
        { client: "new-api", endpoint: "/v1/messages 或 /v1/chat/completions", note: "按上游类型选 Anthropic 或 OpenAI" },
      ]
    : [
        { client: "Claude Code", endpoint: "POST /v1/messages", note: "ANTHROPIC_BASE_URL. Do not use Chat." },
        { client: "Grok Build", endpoint: "POST /v1/responses", note: "api_backend=responses. If previous_response_id returns 422, fall back to chat_completions." },
        { client: "OpenAI SDK", endpoint: "POST /v1/chat/completions", note: "Point base_url at /v1." },
        { client: "new-api", endpoint: "/v1/messages or /v1/chat/completions", note: "Pick Anthropic or OpenAI to match the upstream type." },
      ];

  const patchRoster = (id: string, patch: Partial<RosterItem>) => {
    setRoster((current) => {
      const index = current.findIndex((item) => item.id === id);
      if (index === -1) return current;
      return current.map((item) => (item.id === id ? { ...item, ...patch } : item));
    });
  };

  const loadAccounts = async () => {
    try {
      const accounts = await getManagedAccounts();
      const next = accounts.map((account): RosterItem => ({
        id: account.id,
        key: account.api_key,
        addedAt: account.added_at,
        testState: "idle",
      }));
      setRoster(next);
      setActiveId((current) => next.some((item) => item.id === current) ? current : next[0]?.id ?? "");
      await Promise.all(next.map((item) => probe(item.id, item.key)));
    } catch (error) {
      setAddError(messageOf(error));
      setRoster([]);
    }
  };

  useEffect(() => {
    void loadAccounts();
  }, []);

  const probe = async (id: string, key: string) => {
    const started = performance.now();
    patchRoster(id, { testState: "testing", testError: undefined });
    try {
      const [nextModels, nextAccount] = await Promise.all([getModels(key), getAccount(key)]);
      patchRoster(id, {
        testState: "pass",
        testMs: Math.round(performance.now() - started),
        models: nextModels,
        account: nextAccount,
        testError: undefined,
      });
      setSelectedModel((current) => current || nextModels.data[0]?.id || "");
    } catch (error) {
      patchRoster(id, {
        testState: "fail",
        testMs: Math.round(performance.now() - started),
        testError: messageOf(error),
      });
    }
  };

  const testAccount = async (id: string) => {
    const item = roster.find((entry) => entry.id === id);
    if (!item) return;
    await probe(item.id, item.key);
  };

  const testAll = async () => {
    await Promise.all(roster.map((item) => probe(item.id, item.key)));
  };

  const addAccount = async () => {
    const key = draftKey.trim();
    if (!key) {
      setAddError(t.keyNeeded);
      return;
    }
    setAdding(true);
    setAddError("");
    try {
      const account = await addManagedAccount(key);
      const next: RosterItem = { id: account.id, key: account.api_key, addedAt: account.added_at, testState: "testing" };
      setRoster((current) => current.some((item) => item.id === next.id) ? current : [...current, next]);
      setActiveId(next.id);
      setDraftKey("");
      await probe(next.id, next.key);
    } catch (error) {
      setAddError(messageOf(error));
    } finally {
      setAdding(false);
    }
  };

  const removeAccount = async (id: string) => {
    try {
      await removeManagedAccount(id);
    } catch (error) {
      setAddError(messageOf(error));
      return;
    }
    setRoster((current) => {
      const next = current.filter((item) => item.id !== id);
      if (id === activeId) {
        setActiveId(next[0]?.id ?? "");
        setSelectedModel("");
      }
      return next;
    });
    if (route.accountId === id) go("accounts");
  };

  const run = async () => {
    if (!active?.key || !selectedModel || !prompt.trim()) return;
    setRunState("loading");
    setOutput("");
    try {
      await runPrompt({
        apiKey: active.key,
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

  const copyValue = async (label: string, value: string) => {
    try {
      await copyText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1400);
    } catch {
      setCopied("");
    }
  };

  const healthOk = health?.status === "ok";
  const homeCopy = t.home as unknown as HomeCopy & { add: string; adding: string; keyPlaceholder: string; keyHelp: string; remove: string };

  const pageLabel = pageLabelFor(route.page, t);

  return (
    <BFTheme className="cpa-shell" tone={tone}>
      <a className="skip-link" href="#main-content">{t.skip}</a>
      <aside className="rail">
        <a className="brand" href={hrefFor("home")} aria-label={`${t.product} · ${t.consoleTag}`}>
          <BfMark />
          <span className="brand-text">
            <span className="brand-name">{t.product}</span>
            <span className="brand-prod">{t.consoleTag}</span>
          </span>
        </a>
        <RailNav
          page={route.page}
          operateLabel={t.groupOperate}
          gatewayLabel={t.groupGateway}
          home={t.navHome}
          quota={t.navQuota}
          accounts={t.navAccounts}
          connect={t.navStart}
          playground={t.navPlay}
          homeMeta={t.navHomeMeta}
          quotaMeta={t.navQuotaMeta}
          accountsMeta={t.navAccountsMeta}
          startMeta={t.navStartMeta}
          playMeta={t.navPlayMeta}
          accountCount={roster.length}
          icons={{
            home: <NavIcon name="home" />,
            quota: <NavIcon name="quota" />,
            key: <NavIcon name="key" />,
            start: <NavIcon name="start" />,
            play: <NavIcon name="play" />,
          }}
        />
        <div className="rail-foot">
          <StatusTag tone={healthOk ? "success" : healthError ? "danger" : "progress"}>{healthOk ? t.ready : healthError ? t.unavailable : t.loading}</StatusTag>
          <div className="rail-tools">
            <Button variant="quiet" size="sm" onClick={() => setLanguage(language === "en" ? "zh" : "en")}>{t.language}</Button>
            <Button variant="quiet" size="sm" onClick={() => setTone(tone === "light" ? "dark" : "light")}>{tone === "light" ? t.dark : t.light}</Button>
          </div>
        </div>
      </aside>
      <div className="stage">
      <header className="stage-bar">
        <p className="stage-title">
          {pageLabel}
          {copied ? <span className="copy-toast" role="status">{t.home.copied}</span> : null}
        </p>
        <nav className="links">
          <a href="https://github.com/Sunnyender-org/cursor-sdk2api" target="_blank" rel="noreferrer">{t.source}</a>
          <a href="https://github.com/Sunnyender-org/cursor-sdk2api/blob/main/docs/SECURITY.md" target="_blank" rel="noreferrer">{t.security}</a>
        </nav>
      </header>
      <main id="main-content">
        {route.page === "home" ? (
          <HomePage
            t={homeCopy}
            origin={origin}
            copied={copied}
            ready={healthOk ? t.ready : healthError ? t.unavailable : t.loading}
            readyOk={healthOk}
            sdk={health?.sdk_version ?? "…"}
            version={health?.version ?? "…"}
            instance={health?.instance_id ?? "…"}
            network={health ? (health.network.proxy_configured ? t.proxy : t.direct) : "…"}
            refreshing={refreshingHealth}
            roster={roster}
            onCopy={copyValue}
            onRefresh={() => void refreshHealth()}
          />
        ) : null}
        {route.page === "quota" ? (
          <QuotaPage t={homeCopy} roster={roster} onTest={(id) => void testAccount(id)} onTestAll={() => void testAll()} />
        ) : null}
        {route.page === "accounts" ? (
          <AccountsPage
            t={homeCopy}
            draftKey={draftKey}
            addError={addError}
            adding={adding}
            roster={roster}
            onDraft={setDraftKey}
            onAdd={() => void addAccount()}
            onTest={(id) => void testAccount(id)}
            onRemove={(id) => void removeAccount(id)}
          />
        ) : null}
        {route.page === "account" ? (
          <AccountDetailPage
            t={t.detail}
            item={roster.find((item) => item.id === route.accountId)}
            onTest={(id) => void testAccount(id)}
            onUse={(id) => {
              setActiveId(id);
              go("playground");
            }}
          />
        ) : null}
        {route.page === "playground" ? (
          <PlaygroundPage
            t={t.play}
            roster={roster}
            activeId={activeId}
            protocol={protocol}
            selectedModel={selectedModel}
            prompt={prompt}
            stream={stream}
            output={output}
            runState={runState}
            onActive={setActiveId}
            onProtocol={setProtocol}
            onModel={setSelectedModel}
            onPrompt={setPrompt}
            onStream={setStream}
            onRun={() => void run()}
          />
        ) : null}
        {route.page === "connect" ? (
          <ConnectPage t={t.connect} origin={origin} copied={copied} recipe={recipe} snippets={snippets} routes={clientRoutes} onCopy={copyValue} onRecipe={setRecipe} />
        ) : null}
      </main>
      <footer className="foot">
        <span>BF Labs · MIT · {protocolSummary}</span>
        <span className="foot-origin mono">{origin}</span>
      </footer>
      </div>
    </BFTheme>
  );
}

function pageLabelFor(page: Route["page"], t: (typeof COPY)["en"] | (typeof COPY)["zh"]): string {
  if (page === "connect") return t.navStart;
  if (page === "accounts" || page === "account") return t.navAccounts;
  if (page === "quota") return t.navQuota;
  if (page === "playground") return t.navPlay;
  return t.navHome;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function NavIcon({ name }: { name: "home" | "quota" | "key" | "start" | "play" }) {
  const d =
    name === "home"
      ? "M3 10.5 12 3l9 7.5V21H14V14H10v7H3Z"
      : name === "quota"
        ? "M12 3a9 9 0 1 0 9 9h-4a5 5 0 1 1-5-5V3Zm1 1.1V11h6.9A8 8 0 0 0 13 4.1Z"
        : name === "key"
          ? "M8 14a5 5 0 1 1 4.9-6H21v3h-2v3h-3v2h-3.1A5 5 0 0 1 8 14Zm0-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
          : name === "start"
            ? "M8 5v14l11-7Z"
            : "M4 5h10v4H8v6h6v4H4Zm12 3 5 4-5 4Z";
  return (
    <svg className="nav-ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="currentColor" d={d} />
    </svg>
  );
}

function BfMark() {
  return (
    <svg className="mark" aria-hidden="true" viewBox="0 0 1200 700" width="28" height="16">
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
