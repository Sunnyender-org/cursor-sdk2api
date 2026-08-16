import { Button } from "../bflabs/Button";
import type { RosterItem } from "../roster";
import { AccountTable } from "./AccountTable";
import type { HomeCopy } from "./HomePage";
import { ActionLink, PageFrame } from "./shared";

export function AccountsPage({
  t,
  draftKey,
  addError,
  adding,
  roster,
  onDraft,
  onAdd,
  onTest,
  onRemove,
}: {
  t: HomeCopy & { add: string; adding: string; keyPlaceholder: string; keyHelp: string; remove: string };
  draftKey: string;
  addError: string;
  adding: boolean;
  roster: RosterItem[];
  onDraft: (value: string) => void;
  onAdd: () => void;
  onTest: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const passed = roster.filter((item) => item.testState === "pass").length;
  const failed = roster.filter((item) => item.testState === "fail").length;
  return (
    <PageFrame
      kicker={t.manage}
      title={t.authTitle}
      actions={<ActionLink href="#/">{t.dashTitle}</ActionLink>}
    >
      <p className="page-meta">{t.authMeta
        .replace("{total}", String(roster.length))
        .replace("{ok}", String(passed))
        .replace("{bad}", String(failed))}</p>
      <form
        className="add-row page-add"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd();
        }}
      >
        <input
          type="password"
          value={draftKey}
          autoComplete="off"
          spellCheck={false}
          placeholder={t.keyPlaceholder}
          onChange={(event) => onDraft(event.target.value)}
        />
        <Button type="submit" variant="primary" size="sm" loading={adding} disabled={adding}>
          {adding ? t.adding : t.add}
        </Button>
      </form>
      {addError ? <p className="field-error" role="alert">{addError}</p> : null}
      <p className="note">{t.keyHelp}</p>
      {roster.length === 0 ? <p className="empty">{t.noAccounts}</p> : (
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
          remove={t.remove}
          headers={t.headers}
          onTest={onTest}
          onRemove={onRemove}
        />
      )}
    </PageFrame>
  );
}
