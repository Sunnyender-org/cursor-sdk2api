import type { StoredCursorAccount } from "../account/file-store.js";

type RotationKey = Pick<StoredCursorAccount, "id" | "addedAt">;

function byStableOrder(left: RotationKey, right: RotationKey): number {
  return left.addedAt - right.addedAt || left.id.localeCompare(right.id);
}

export class CursorAccountPool {
  private readonly lastPicked = new Map<string, RotationKey>();

  pick(accounts: StoredCursorAccount[], routeKey: string): StoredCursorAccount | undefined {
    if (accounts.length === 0) return undefined;
    const ordered = [...accounts].sort(byStableOrder);
    // A numeric cursor is rescaled by every filtered candidate set and can starve a healthy account.
    const previous = this.lastPicked.get(routeKey);
    const selected = (previous && ordered.find((account) => byStableOrder(previous, account) < 0)) || ordered[0];
    if (selected) this.lastPicked.set(routeKey, { id: selected.id, addedAt: selected.addedAt });
    return selected;
  }
}
