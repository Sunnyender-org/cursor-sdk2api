import { Button } from "../bflabs/Button";
import { CountUp } from "../bflabs/CountUp";
import { catalogHasFable5 } from "../fable5";
import { hrefFor } from "../nav";
import { formatGrokBotQuota, formatQuota } from "../quota";
import { identityLabel, type RosterItem } from "../roster";
import type { HomeCopy } from "./HomePage";
import { QuotaPair } from "./QuotaMeters";
import { ActionLink, PageFrame } from "./shared";

export function QuotaPage({
  t,
  roster,
  onTest,
  onTestAll,
}: {
  t: HomeCopy;
  roster: RosterItem[];
  onTest: (id: string) => void;
  onTestAll: () => void;
}) {
  const passed = roster.filter((item) => item.testState === "pass");
  const failed = roster.filter((item) => item.testState === "fail");
  const quotaKnown = passed.filter((item) => formatQuota(item.account) || formatGrokBotQuota(item.account)).length;
  const fableOn = passed.filter((item) => catalogHasFable5(item.models)).length;
  const fableOff = passed.filter((item) => item.models && !catalogHasFable5(item.models)).length;

  return (
    <PageFrame
      kicker={t.quotaPageKicker}
      title={t.quotaPageTitle}
      actions={<Button variant="primary" size="sm" onClick={onTestAll}>{t.testAll}</Button>}
    >
      <p className="page-meta">{t.quotaDesc}</p>
      <dl className="overview">
        <div><dt>{t.totalAccounts}</dt><dd><CountUp value={roster.length} /></dd></div>
        <div><dt>{t.tested}</dt><dd><CountUp value={passed.length} />{failed.length ? <> / <CountUp value={failed.length} /> {t.failed}</> : ""}</dd></div>
        <div><dt>{t.quotaKnown}</dt><dd><CountUp value={quotaKnown} /><small>{t.quotaHint}</small></dd></div>
        <div><dt>Fable 5</dt><dd><CountUp value={fableOn} /> {t.fableOnShort} · <CountUp value={fableOff} /> {t.fableOffShort}</dd></div>
      </dl>
      {roster.length === 0 ? (
        <p className="empty">{t.noAccounts} <a href={hrefFor("accounts")}>{t.manage}</a></p>
      ) : (
        <ul className="quota-accounts">
          {roster.map((item) => (
            <li key={item.id} className="quota-account">
              <div className="quota-account-head">
                <a className="row-link" href={hrefFor("account", item.id)}>
                  <strong>{identityLabel(item.account, item.keyHint)}</strong>
                  <span className="sub">{item.account?.identity?.api_key_name || item.keyHint}</span>
                </a>
                <div className="row-action-group">
                  <Button variant="secondary" size="sm" disabled={item.testState === "testing"} onClick={() => onTest(item.id)}>
                    {item.testState === "testing" ? t.testing : t.test}
                  </Button>
                  <ActionLink href={hrefFor("account", item.id)}>{t.open}</ActionLink>
                </div>
              </div>
              <QuotaPair
                account={item.account}
                cursorLabel={t.cursorQuota}
                grokLabel={t.grokBotQuota}
                cursorMissing={t.quotaMissing}
                grokMissing={t.grokBotMissing}
                remainingPrefix={t.remainingPrefix}
                resetPrefix={t.resetPrefix}
              />
            </li>
          ))}
        </ul>
      )}
    </PageFrame>
  );
}
