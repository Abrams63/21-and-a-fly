import { type CSSProperties, type ReactNode, useId } from "react";
import styles from "./InfoTip.module.css";

interface Props {
  /** What the term is, for screen readers: "About flies ruined". */
  label: string;
  children: ReactNode;
}

/**
 * A small "i" button that opens a glossary note. Uses the native popover
 * (light dismiss, Esc, focus handling) and CSS anchor positioning.
 */
export function InfoTip({ label, children }: Props) {
  const id = useId();
  const anchor = `--tip-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        popoverTarget={id}
        aria-label={label}
        style={{ anchorName: anchor } as CSSProperties}
      >
        i
      </button>
      <div
        id={id}
        popover="auto"
        role="note"
        className={styles.tip}
        style={{ positionAnchor: anchor } as CSSProperties}
      >
        {children}
      </div>
    </>
  );
}
