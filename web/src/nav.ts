export type Page = "home" | "accounts" | "account" | "quota" | "playground" | "connect";

export interface Route {
  page: Page;
  accountId?: string;
}

export function readRoute(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [head, id] = raw.split("/");
  if (head === "accounts" && id) return { page: "account", accountId: id };
  if (head === "accounts") return { page: "accounts" };
  if (head === "quota") return { page: "quota" };
  if (head === "playground") return { page: "playground" };
  if (head === "connect") return { page: "connect" };
  return { page: "home" };
}

export function hrefFor(page: Page, accountId?: string): string {
  if (page === "home") return "#/";
  if (page === "account" && accountId) return `#/accounts/${accountId}`;
  return `#/${page}`;
}

export function go(page: Page, accountId?: string): void {
  window.location.hash = hrefFor(page, accountId).slice(1);
}
