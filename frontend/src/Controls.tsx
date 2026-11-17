import { useEffect } from "react";
import type { ClientMessage, Phase } from "../shared/protocol";
import styles from "./Controls.module.css";

interface Props {
  phase: Phase;
  roundId: number;
  bet: number;
  canDeal: boolean;
  send: (message: ClientMessage) => void;
}

const PROMPT: Record<Phase, string> = {
  idle: "Place a bet and deal",
  dealing: "Dealing…",
  player: "Your move",
  fly: "The fly is thinking…",
  dealer: "Dealer's turn…",
  settled: "Round over",
};

export function Controls({ phase, roundId, bet, canDeal, send }: Props) {
  const yourTurn = phase === "player";

  // Keyboard shortcuts: H — hit, S — stand, N — deal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input:not([type=radio]), textarea, select, [contenteditable]")) return;
      const key = event.code;
      if (key === "KeyH" && yourTurn) send({ type: "hit" });
      else if (key === "KeyS" && yourTurn) send({ type: "stand" });
      else if (key === "KeyN" && canDeal) send({ type: "new_round", bet });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [yourTurn, canDeal, bet, send]);

  return (
    <div className={styles.controls}>
      <p className={styles.prompt} role="status" data-phase={phase}>
        {roundId > 0 && <span className={styles.round}>round {roundId} · </span>}
        {PROMPT[phase]}
      </p>
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.button}
          disabled={!yourTurn}
          aria-keyshortcuts="H"
          onClick={() => send({ type: "hit" })}
        >
          Hit <kbd className={styles.kbd}>H</kbd>
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={!yourTurn}
          aria-keyshortcuts="S"
          onClick={() => send({ type: "stand" })}
        >
          Stand <kbd className={styles.kbd}>S</kbd>
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={!canDeal}
          aria-keyshortcuts="N"
          onClick={() => send({ type: "new_round", bet })}
        >
          Deal · {bet} <kbd className={styles.kbd}>N</kbd>
        </button>
      </div>
    </div>
  );
}
