import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";

export type TabItem = {
  value: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
};

export type TabsProps = {
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  label?: string;
};

export function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  className,
  label = "Content views",
}: TabsProps) {
  const id = useId().replace(/:/g, "");
  const firstEnabled = items.find((item) => !item.disabled)?.value ?? "";
  const [internalValue, setInternalValue] = useState(defaultValue ?? firstEnabled);
  const activeValue = value ?? internalValue;
  const activeItem = items.find((item) => item.value === activeValue) ?? items[0];

  const select = (nextValue: string) => {
    if (value === undefined) setInternalValue(nextValue);
    onValueChange?.(nextValue);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const enabled = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled);
    const enabledPosition = enabled.findIndex(({ index }) => index === currentIndex);
    let nextPosition = enabledPosition;
    if (event.key === "ArrowRight") nextPosition = (enabledPosition + 1) % enabled.length;
    if (event.key === "ArrowLeft") nextPosition = (enabledPosition - 1 + enabled.length) % enabled.length;
    if (event.key === "Home") nextPosition = 0;
    if (event.key === "End") nextPosition = enabled.length - 1;
    const next = enabled[nextPosition];
    if (!next) return;
    select(next.item.value);
    document.getElementById(`${id}-tab-${next.index}`)?.focus();
  };

  return (
    <div className={cx("bf-tabs", className)} data-slot="tabs">
      <div className="bf-tabs__list" role="tablist" aria-label={label}>
        {items.map((item, index) => {
          const selected = item.value === activeItem?.value;
          return (
            <button
              id={`${id}-tab-${index}`}
              key={item.value}
              type="button"
              className="bf-tabs__tab"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => select(item.value)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        id={`${id}-panel`}
        className="bf-tabs__panel"
        role="tabpanel"
        aria-labelledby={`${id}-tab-${Math.max(0, items.findIndex((item) => item.value === activeItem?.value))}`}
      >
        {activeItem?.content}
      </div>
    </div>
  );
}
