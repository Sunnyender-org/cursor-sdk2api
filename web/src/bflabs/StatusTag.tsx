import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export type StatusTagProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "progress" | "success" | "accent" | "danger";
};

export function StatusTag({ tone = "neutral", className, children, ...props }: StatusTagProps) {
  return (
    <span className={cx("bf-status-tag", `bf-status-tag--${tone}`, className)} {...props}>
      <span className="bf-status-tag__dot" aria-hidden="true" />
      {children}
    </span>
  );
}
