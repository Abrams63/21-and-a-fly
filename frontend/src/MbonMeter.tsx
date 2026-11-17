import type { CSSProperties } from "react";
import type { Action } from "../shared/protocol";
import styles from "./MbonMeter.module.css";

interface Props {
  hit: number;
  stand: number;
  /** The winning action once the replay is over. */
  action: Action | null;
}

/** The race between the two MBON pools that decides the fly's move. */
export function MbonMeter({ hit, stand, action }: Props) {
  const max = Math.max(hit, stand, 40);
  const rows = [
    { id: "hit", label: "hit", value: hit },
    { id: "stand", label: "stand", value: stand },
  ] as const;

  return (
    <dl className={styles.meter}>
      {rows.map((row) => (
        <div key={row.id} className={styles.row} data-winner={action === row.id || undefined}>
          <dt className={styles.label}>MBON {row.label}</dt>
          <dd className={styles.track}>
            <span className={styles.bar} style={{ "--v": row.value / max } as CSSProperties} />
          </dd>
          <dd className={styles.value}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
