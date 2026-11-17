import type { CSSProperties } from "react";
import type { FlyEvictedEvent } from "../shared/protocol";
import styles from "./FlyEviction.module.css";
import { FlyGlyph } from "./FlyGlyph";

interface Props {
  event: FlyEvictedEvent;
  drunk: number;
}

/** The broke fly gets swept off the table and a new one takes the seat. */
export function FlyEviction({ event, drunk }: Props) {
  return (
    <div className={styles.overlay} role="status" style={{ "--duration": `${event.replayMs}ms` } as CSSProperties}>
      <div className={styles.scene} aria-hidden="true">
        <span className={styles.broom}>🧹</span>
        <span className={styles.departing}>
          <FlyGlyph busy drunk={drunk} />
        </span>
      </div>
      <p className={styles.gone}>Fly #{event.ruinedNumber} is broke and got shooed off the table!</p>
      <p className={styles.arrive}>
        Fly #{event.newNumber} sits down with <strong>{event.newBalance.toLocaleString("en-US")}</strong> chips
      </p>
    </div>
  );
}
