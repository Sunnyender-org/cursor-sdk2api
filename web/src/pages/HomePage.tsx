import { maskKey } from "../accounts";
import { Button } from "../bflabs/Button";
import { CountUp } from "../bflabs/CountUp";
import { Reveal } from "../bflabs/Reveal";
import { StatusTag } from "../bflabs/StatusTag";
import { catalogHasFable5 } from "../fable5";
import { hrefFor } from "../nav";
import { formatQuota } from "../quota";
import type { RosterItem } from "../roster";

const API_CARDS = [
  { id: "messages", name: "Messages", path: "/v1/messages" },
  { id: "chat", name: "Chat", path: "/v1/chat/completions" },
  { id: "responses", name: "Responses", path: "/v1/responses" },
] as const;

export function HomePage({
  t,
  origin,
  copied,
  ready,
  readyOk,
  sdk,
  version,
  instance,
  network,
  refreshing,
  roster,
  onCopy,
  onRefresh,
}: {
  t: HomeCopy;
  origin: string;
  copied: string;
  ready: string;
  readyOk: boolean;
  sdk: string;
  version: string;
  instance: string;
  network: string;
  refreshing: boolean;
  roster: RosterItem[];
  onCopy: (label: string, value: string) => void;
  onRefresh: () => void;
}) {
  const passed = roster.filter((item) => item.testState === "pass");
  const failed = roster.filter((item) => item.testState === "fail");
  const quotaKnown = passed.filter((item) => formatQuota(item.account)).length;
  const fableOn = passed.filter((item) => catalogHasFable5(item.models)).length;
  const fableOff = passed.filter((item) => item.models && !catalogHasFable5(item.models)).length;
  const first = roster[0];
  const hints = {
    messages: t.messagesHint,
    chat: t.chatHint,
    responses: t.responsesHint,
  };

  return (
    <section className="page home-easy">
      <div className="home-split">
        <Reveal delay={40} className="easy-panel">
          <header className="easy-head">
            <h1>{t.controlTitle}</h1>
            <StatusTag tone={readyOk ? "success" : refreshing ? "progress" : "danger"}>{refreshing ? t.refreshing : ready}</StatusTag>
          </header>
          <dl className="easy-facts">
            <div><dt>{t.process}</dt><dd>{readyOk ? t.processUp : t.processDown}</dd></div>
            <div><dt>{t.status}</dt><dd>{ready}</dd></div>
            <div><dt>{t.instance}</dt><dd className="mono">{shortInstance(instance)}</dd></div>
            <div><dt>SDK</dt><dd>{sdk}</dd></div>
            <div><dt>{t.version}</dt><dd>{version}</dd></div>
            <div><dt>{t.net}</dt><dd>{network}</dd></div>
          </dl>
          <div className="easy-actions">
            <Button variant="secondary" size="sm" loading={refreshing} disabled={refreshing} onClick={onRefresh}>
              {t.refresh}
            </Button>
            <a className="bf-button bf-button--secondary bf-button--sm" href={hrefFor("accounts")}>
              <span>{t.manage}</span>
            </a>
          </div>
        </Reveal>

        <Reveal delay={120} className="easy-panel">
          <header className="easy-head">
            <div>
              <h2>{t.apiTitle}</h2>
              {first ? (
                <p className="easy-key">
                  <span>{t.firstKey}</span>
                  <code className="mono">{maskKey(first.key)}</code>
                  <Button variant="quiet" size="sm" data-copied={copied === "home-key" ? "true" : undefined} onClick={() => onCopy("home-key", first.key)}>
                    {copied === "home-key" ? t.copied : t.copy}
                  </Button>
                </p>
              ) : (
                <p className="easy-key"><a href={hrefFor("accounts")}>{t.noKey}</a></p>
              )}
            </div>
            <StatusTag tone={readyOk ? "success" : "progress"}>{readyOk ? t.reachable : t.waitingLink}</StatusTag>
          </header>
          <div className="api-cards">
            {API_CARDS.map((card) => {
              const url = `${origin}${card.path}`;
              return (
                <article className="api-card" key={card.id}>
                  <strong>{card.name}</strong>
                  <span>{hints[card.id]}</span>
                  <div className="api-url">
                    <div className="api-url-row">
                      <em>{t.localUrl}</em>
                      <Button variant="quiet" size="sm" data-copied={copied === card.id ? "true" : undefined} onClick={() => onCopy(card.id, url)}>
                        {copied === card.id ? t.copied : t.copy}
                      </Button>
                    </div>
                    <code className="mono" title={url}>{url}</code>
                  </div>
                </article>
              );
            })}
          </div>
        </Reveal>
      </div>

      <Reveal delay={200}>
        <h2 className="subhead">{t.fleet}</h2>
        <dl className="overview">
          <div><dt>{t.totalAccounts}</dt><dd><CountUp value={roster.length} /></dd></div>
          <div><dt>{t.tested}</dt><dd><CountUp value={passed.length} />{failed.length ? <> / <CountUp value={failed.length} /> {t.failed}</> : ""}</dd></div>
          <div><dt>{t.quotaKnown}</dt><dd><CountUp value={quotaKnown} /><small>{t.quotaHint}</small></dd></div>
          <div><dt>Fable 5</dt><dd><CountUp value={fableOn} /> {t.fableOnShort} · <CountUp value={fableOff} /> {t.fableOffShort}</dd></div>
        </dl>
      </Reveal>
    </section>
  );
}

function shortInstance(value: string): string {
  const match = value.match(/^inst_([0-9a-f-]+)/i);
  const id = match?.[1];
  if (!id) return value;
  return `inst_${id.replace(/-/g, "").slice(0, 8)}`;
}

export type HomeCopy = {
  kicker: string;
  title: string;
  dashTitle: string;
  status: string;
  net: string;
  api: string;
  version: string;
  instance: string;
  runtime: string;
  fleet: string;
  controlTitle: string;
  apiTitle: string;
  process: string;
  processUp: string;
  processDown: string;
  refresh: string;
  refreshing: string;
  firstKey: string;
  noKey: string;
  localUrl: string;
  reachable: string;
  waitingLink: string;
  messagesHint: string;
  chatHint: string;
  responsesHint: string;
  verdictGood: string;
  verdictWarn: string;
  verdictIdle: string;
  verdictOffline: string;
  verdictGoodBody: string;
  verdictWarnBody: string;
  verdictIdleBody: string;
  verdictOfflineBody: string;
  nextKicker: string;
  nextTitle: string;
  nextQuota: string;
  nextQuotaDesc: string;
  nextAuth: string;
  nextAuthDesc: string;
  nextPlay: string;
  nextPlayDesc: string;
  nextStart: string;
  nextStartDesc: string;
  quickStart: string;
  quotaPageKicker: string;
  quotaPageTitle: string;
  quotaDesc: string;
  manage: string;
  authTitle: string;
  authMeta: string;
  tryPlay: string;
  origin: string;
  copy: string;
  copied: string;
  totalAccounts: string;
  tested: string;
  failed: string;
  quotaKnown: string;
  quotaHint: string;
  fableOnShort: string;
  fableOffShort: string;
  breakdown: string;
  testAll: string;
  noAccounts: string;
  quotaMissing: string;
  fableOn: string;
  fableOff: string;
  fableUnknown: string;
  testing: string;
  test: string;
  testFail: string;
  open: string;
  headers: [string, string, string, string];
};
