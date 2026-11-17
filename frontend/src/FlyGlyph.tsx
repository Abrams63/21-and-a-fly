import type { CSSProperties } from "react";
import styles from "./FlyGlyph.module.css";

interface Props {
  /** Wings buzz while the fly is deciding (or fleeing). */
  busy: boolean;
  /** 0..1, makes the fly sway. */
  drunk: number;
  /** Delay before a newly seated fly lands, so it arrives after the eviction scene. */
  enterDelayMs?: number;
}

export function FlyGlyph({ busy, drunk, enterDelayMs = 0 }: Props) {
  return (
    <svg
      className={styles.fly}
      data-busy={busy || undefined}
      data-drunk={drunk > 0.25 || undefined}
      style={{ "--drunk": drunk, "--enter-delay": `${enterDelayMs}ms` } as CSSProperties}
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      <g className={styles.wings}>
        <ellipse className={`${styles.wing} ${styles.wingLeft}`} cx="20" cy="30" rx="15" ry="7" />
        <ellipse className={`${styles.wing} ${styles.wingRight}`} cx="44" cy="30" rx="15" ry="7" />
      </g>
      <g className={styles.legs}>
        <path d="M27 30 L14 22 M27 36 L12 38 M28 42 L16 52 M37 30 L50 22 M37 36 L52 38 M36 42 L48 52" />
      </g>
      <ellipse className={styles.body} cx="32" cy="38" rx="7" ry="12" />
      <circle className={styles.body} cx="32" cy="22" r="7" />
      <circle className={styles.eye} cx="27.5" cy="20" r="3.6" />
      <circle className={styles.eye} cx="36.5" cy="20" r="3.6" />
    </svg>
  );
}
