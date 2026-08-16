import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { ArrowRightIcon } from "./icons";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "accent" | "quiet";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode | boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading = false,
      leadingIcon,
      trailingIcon,
      disabled,
      className,
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type="button"
      className={cx("bf-button", `bf-button--${variant}`, `bf-button--${size}`, className)}
      data-slot="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <span className="bf-button__spinner" aria-hidden="true" /> : null}
      {!loading && leadingIcon ? (
        <span className="bf-button__icon bf-button__icon--start" aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      <span>{children}</span>
      {!loading && trailingIcon ? (
        <span className="bf-button__icon bf-button__icon--end" aria-hidden="true">
          {trailingIcon === true ? <ArrowRightIcon /> : trailingIcon}
        </span>
      ) : null}
    </button>
  ),
);

Button.displayName = "Button";
