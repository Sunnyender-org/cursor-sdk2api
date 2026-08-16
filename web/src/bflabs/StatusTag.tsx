import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export type StatusTagTone = "neutral" | "progress" | "success" | "accent" | "danger";

export type StatusTagProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: StatusTagTone;
  showDot?: boolean;
};

export function StatusTag({
  tone = "neutral",
  showDot = true,
  className,
  children,
  ...props
}: StatusTagProps) {
  return (
    <span
      className={cx("bf-status-tag", `bf-status-tag--${tone}`, className)}
      data-slot="status-tag"
      {...props}
    >
      {showDot ? <span className="bf-status-tag__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
