import { forwardRef, type HTMLAttributes } from "react";
import { cx } from "./cx";

export type BFThemeTone = "light" | "dark";

export type BFThemeProps = HTMLAttributes<HTMLDivElement> & {
  tone?: BFThemeTone;
};

export const BFTheme = forwardRef<HTMLDivElement, BFThemeProps>(
  ({ tone = "light", className, ...props }, ref) => (
    <div ref={ref} className={cx("bf-theme", className)} data-tone={tone} {...props} />
  ),
);

BFTheme.displayName = "BFTheme";
