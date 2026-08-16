import type { ReactNode } from "react";
import { cx } from "../bflabs/cx";
import { Reveal } from "../bflabs/Reveal";

export function PageFrame({ title, kicker, actions, children }: {
  title: string;
  kicker?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Reveal className="page" delay={30} distance={14}>
      <header className="page-head">
        <div>
          {kicker ? <p className="kicker">{kicker}</p> : null}
          <h1>{title}</h1>
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </header>
      {children}
    </Reveal>
  );
}

export function ActionLink({
  href,
  children,
  variant = "secondary",
  size = "sm",
  target,
  rel,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "accent" | "quiet";
  size?: "sm" | "md";
  target?: string;
  rel?: string;
}) {
  return (
    <a
      className={cx("bf-button", `bf-button--${variant}`, `bf-button--${size}`)}
      href={href}
      target={target}
      rel={rel}
    >
      <span>{children}</span>
    </a>
  );
}
