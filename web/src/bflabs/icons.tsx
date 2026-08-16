import type { SVGProps } from "react";

export function ArrowRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M5 12h13M14 7l5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="m6.5 12.5 3.5 3.5 7.5-8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
