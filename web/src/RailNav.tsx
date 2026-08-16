import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Page } from "./nav";
import { hrefFor } from "./nav";

export function RailNav({
  page,
  operateLabel,
  gatewayLabel,
  home,
  quota,
  accounts,
  connect,
  playground,
  homeMeta,
  quotaMeta,
  accountsMeta,
  startMeta,
  playMeta,
  accountCount,
  icons,
}: {
  page: Page;
  operateLabel: string;
  gatewayLabel: string;
  home: string;
  quota: string;
  accounts: string;
  connect: string;
  playground: string;
  homeMeta: string;
  quotaMeta: string;
  accountsMeta: string;
  startMeta: string;
  playMeta: string;
  accountCount: number;
  icons: Record<"home" | "quota" | "key" | "start" | "play", ReactNode>;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [bar, setBar] = useState({ top: 0, height: 0, ready: false });
  const current = page === "account" ? "accounts" : page;

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const currentEl = nav.querySelector<HTMLElement>("a[aria-current='page']");
      if (!currentEl) return;
      const nr = nav.getBoundingClientRect();
      const cr = currentEl.getBoundingClientRect();
      setBar({
        top: cr.top - nr.top + nav.scrollTop,
        height: cr.height,
        ready: true,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [current, accountCount, home, quota, accounts, connect, playground]);

  return (
    <nav ref={navRef} className="rail-nav" aria-label="cursor-sdk2api">
      <span
        className="rail-indicator"
        style={{ top: bar.top, height: bar.height, opacity: bar.ready ? 1 : 0 }}
        aria-hidden="true"
      />
      <div className="nav-block">
        <p className="nav-group" id="nav-operate">{operateLabel}</p>
        <div role="group" aria-labelledby="nav-operate">
          <a href={hrefFor("home")} title={homeMeta} aria-current={current === "home" ? "page" : undefined}>{icons.home}{home}</a>
          <a href={hrefFor("quota")} title={quotaMeta} aria-current={current === "quota" ? "page" : undefined}>{icons.quota}{quota}</a>
        </div>
      </div>
      <div className="nav-block">
        <p className="nav-group" id="nav-gateway">{gatewayLabel}</p>
        <div role="group" aria-labelledby="nav-gateway">
          <a href={hrefFor("accounts")} title={accountsMeta} aria-current={current === "accounts" ? "page" : undefined}>{icons.key}{accounts}<small>{accountCount}</small></a>
          <a href={hrefFor("connect")} title={startMeta} aria-current={current === "connect" ? "page" : undefined}>{icons.start}{connect}</a>
          <a href={hrefFor("playground")} title={playMeta} aria-current={current === "playground" ? "page" : undefined}>{icons.play}{playground}</a>
        </div>
      </div>
    </nav>
  );
}
