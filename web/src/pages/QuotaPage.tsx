import { Button } from "../bflabs/Button";
import { CountUp } from "../bflabs/CountUp";
import { catalogHasFable5 } from "../fable5";
import { hrefFor } from "../nav";
import { formatQuota } from "../quota";
import type { RosterItem } from "../roster";
import { AccountTable } from "./AccountTable";
import type { HomeCopy } from "./HomePage";
import { PageFrame } from "./shared";

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
  const quotaKnown = passed.filter((item) => formatQuota(item.account)).length;
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
        <AccountTable
          items={roster}
          quotaMissing={t.quotaMissing}
          fableOn={t.fableOn}
          fableOff={t.fableOff}
          fableUnknown={t.fableUnknown}
          testing={t.testing}
          test={t.test}
          testFail={t.testFail}
          open={t.open}
          headers={t.headers}
          onTest={onTest}
        />
      )}
    </PageFrame>
  );
}
