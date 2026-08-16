import { Button } from "../bflabs/Button";
import { catalogHasFable5, FABLE5_DASHBOARD, FABLE5_DOCS, modelLooksLikeFable5 } from "../fable5";
import { hrefFor } from "../nav";
import { formatQuota, formatQuotaBreakdown } from "../quota";
import { identityLabel, type RosterItem } from "../roster";
import { ActionLink, PageFrame } from "./shared";

export function AccountDetailPage({
  t,
  item,
  onTest,
  onUse,
}: {
  t: {
    missing: string;
    back: string;
    test: string;
    testing: string;
    use: string;
    quota: string;
    quotaMissing: string;
    quotaOpen: string;
    fableOn: string;
    fableOff: string;
    fableUnknown: string;
    fableHelp: string;
    fableOpen: string;
    fableDocs: string;
    models: string;
    noModels: string;
    cursorUsage: string;
  };
  item?: RosterItem;
  onTest: (id: string) => void;
  onUse: (id: string) => void;
}) {
  if (!item) {
    return (
      <PageFrame title={t.missing} actions={<ActionLink href={hrefFor("accounts")}>{t.back}</ActionLink>}>
        <p className="empty">{t.missing}</p>
      </PageFrame>
    );
  }

  const quota = formatQuota(item.account);
  const quotaBreakdown = formatQuotaBreakdown(item.account);
  const fable = item.models ? (catalogHasFable5(item.models) ? "on" : "off") : "unknown";

  return (
    <PageFrame
      kicker={item.keyHint}
      title={identityLabel(item.account, item.keyHint)}
      actions={
        <>
          <ActionLink href={hrefFor("accounts")}>{t.back}</ActionLink>
          <Button variant="secondary" size="sm" disabled={item.testState === "testing"} onClick={() => onTest(item.id)}>
            {item.testState === "testing" ? t.testing : t.test}
          </Button>
          <Button variant="primary" size="sm" onClick={() => onUse(item.id)}>{t.use}</Button>
        </>
      }
    >
      <dl className="detail-list">
        <div>
          <dt>{t.quota}</dt>
          <dd>
            {quota || t.quotaMissing}
            {quotaBreakdown ? <span className="sub quota-breakdown">{quotaBreakdown}</span> : null}
          </dd>
        </div>
        <div>
          <dt>Fable 5</dt>
          <dd>{fable === "on" ? t.fableOn : fable === "off" ? t.fableOff : t.fableUnknown}</dd>
        </div>
      </dl>
      {fable === "off" ? (
        <div className="callout">
          <p>{t.fableHelp}</p>
          <ActionLink href={FABLE5_DASHBOARD} variant="accent" target="_blank" rel="noreferrer">{t.fableOpen}</ActionLink>
          <ActionLink href={FABLE5_DOCS} variant="quiet" target="_blank" rel="noreferrer">{t.fableDocs}</ActionLink>
        </div>
      ) : null}
      <p><a className="quiet-link" href={t.cursorUsage} target="_blank" rel="noreferrer">{t.quotaOpen}</a></p>
      <h2 className="subhead">{t.models}</h2>
      {!item.models ? <p className="empty">{t.testing}</p> : null}
      {item.models && item.models.data.length === 0 ? <p className="empty">{t.noModels}</p> : null}
      <ul className="model-plain">
        {item.models?.data.map((model) => (
          <li key={model.id}>
            <strong>{model.display_name || model.id}</strong>
            <span className="sub">{model.id}</span>
            {modelLooksLikeFable5(model.id, model.display_name) ? <span className="tag">Fable 5</span> : null}
          </li>
        ))}
      </ul>
    </PageFrame>
  );
}
