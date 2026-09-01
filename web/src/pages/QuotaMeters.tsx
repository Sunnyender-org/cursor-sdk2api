import {
  cursorUsedPercent,
  formatPercent,
  formatQuota,
  formatQuotaBreakdown,
  formatResetAt,
  grokBotRemainingPercent,
  grokBotUsedPercent,
} from "../quota";
import type { AccountPayload } from "../types";

export function QuotaPair({
  account,
  cursorLabel,
  grokLabel,
  cursorMissing,
  grokMissing,
  remainingPrefix,
  resetPrefix,
}: {
  account?: AccountPayload;
  cursorLabel: string;
  grokLabel: string;
  cursorMissing: string;
  grokMissing: string;
  remainingPrefix: string;
  resetPrefix: string;
}) {
  const cursorUsed = cursorUsedPercent(account);
  const grokUsed = grokBotUsedPercent(account);
  const grokRemaining = grokBotRemainingPercent(account);
  const cursorDetail = [formatQuota(account), formatQuotaBreakdown(account)].filter(Boolean).join(" · ");
  const plan = typeof account?.grok_bot?.plan_label === "string" ? account.grok_bot.plan_label.trim() : "";
  const grokDetail = [
    grokRemaining !== undefined ? remainingPrefix.replace("{n}", formatPercent(grokRemaining)) : "",
    plan,
    formatResetAt(account?.grok_bot?.next_reset_timestamp_utc, resetPrefix),
  ].filter(Boolean).join(" · ");

  return (
    <div className="quota-pair">
      <QuotaMeter
        label={cursorLabel}
        usedPercent={cursorUsed}
        detail={cursorDetail}
        missing={cursorMissing}
      />
      <QuotaMeter
        label={grokLabel}
        usedPercent={grokUsed}
        detail={grokDetail}
        missing={grokMissing}
      />
    </div>
  );
}

function QuotaMeter({
  label,
  usedPercent,
  detail,
  missing,
}: {
  label: string;
  usedPercent?: number;
  detail?: string;
  missing: string;
}) {
  const known = usedPercent !== undefined;
  const width = known ? Math.min(100, Math.max(0, usedPercent)) : 0;
  return (
    <div className="quota-meter">
      <div className="bf-progress">
        <div className="bf-progress__meta">
          <span>{label}</span>
          <span>{known ? formatPercent(width) : ""}</span>
        </div>
        <div className="bf-progress__track">
          <div
            className="bf-progress__value"
            style={{ width: known ? `${width}%` : "0%" }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={known ? Math.round(width) : undefined}
            aria-label={label}
          />
        </div>
      </div>
      <p className="quota-meter-detail">{detail || missing}</p>
    </div>
  );
}
