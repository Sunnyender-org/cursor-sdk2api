import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import { cx } from "./cx";

export type RevealProps = HTMLAttributes<HTMLDivElement> & {
  delay?: number;
  distance?: number;
  once?: boolean;
};

type RevealStyle = CSSProperties & {
  "--bf-reveal-delay": string;
  "--bf-reveal-distance": string;
};

export const Reveal = forwardRef<HTMLDivElement, RevealProps>(
  ({ delay = 0, distance = 16, once = true, className, style, ...props }, forwardedRef) => {
    const localRef = useRef<HTMLDivElement | null>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
      const element = localRef.current;
      if (!element || typeof IntersectionObserver === "undefined") {
        setVisible(true);
        return;
      }
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry?.isIntersecting) {
            setVisible(true);
            if (once) observer.disconnect();
          } else if (!once) {
            setVisible(false);
          }
        },
        { threshold: 0.08 },
      );
      observer.observe(element);
      return () => observer.disconnect();
    }, [once]);

    const setRefs = (node: HTMLDivElement | null) => {
      localRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    };

    return (
      <div
        ref={setRefs}
        className={cx("bf-reveal", className)}
        data-slot="reveal"
        data-visible={visible}
        style={
          {
            "--bf-reveal-delay": `${delay}ms`,
            "--bf-reveal-distance": `${distance}px`,
            ...style,
          } as RevealStyle
        }
        {...props}
      />
    );
  },
);

Reveal.displayName = "Reveal";
