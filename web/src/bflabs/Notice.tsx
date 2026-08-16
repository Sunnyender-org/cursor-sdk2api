import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { CheckIcon } from "./icons";

export type NoticeProps = HTMLAttributes<HTMLDivElement> & {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
};

export function Notice({
  title,
  description,
  icon = <CheckIcon />,
  action,
  className,
  ...props
}: NoticeProps) {
  return (
    <div className={cx("bf-notice", className)} data-slot="notice" role="status" {...props}>
      <span className="bf-notice__icon" aria-hidden="true">{icon}</span>
      <span className="bf-notice__copy">
        <strong className="bf-notice__title">{title}</strong>
        {description ? <span className="bf-notice__description">{description}</span> : null}
      </span>
      {action}
    </div>
  );
}
