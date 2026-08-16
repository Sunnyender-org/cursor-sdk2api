import type { StoredCursorAccount } from "../account/file-store.js";

export class CursorAccountPool {
  private readonly cursors = new Map<string, number>();

  pick(accounts: StoredCursorAccount[], routeKey: string): StoredCursorAccount | undefined {
    if (accounts.length === 0) return undefined;
    const ordered = [...accounts].sort((left, right) => left.addedAt - right.addedAt || left.id.localeCompare(right.id));
    const cursor = this.cursors.get(routeKey) ?? 0;
    const selected = ordered[cursor % ordered.length];
    this.cursors.set(routeKey, (cursor + 1) % ordered.length);
    return selected;
  }
}
