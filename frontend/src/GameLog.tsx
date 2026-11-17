import { useEffect, useId, useRef, useState } from "react";
import type { LogEntry } from "../shared/protocol";
import styles from "./GameLog.module.css";

const WHO: Record<LogEntry["who"], string> = {
  dealer: "dealer",
  player: "you",
  fly: "fly",
  system: "table",
};

const STORAGE_KEY = "fly21.logOpen";

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function GameLog({ entries }: { entries: LogEntry[] }) {
  const [open, setOpen] = useState(readOpen);
  const listRef = useRef<HTMLOListElement>(null);
  const listId = useId();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(open));
    } catch {
      // Storage may be blocked; the toggle still works for this visit.
    }
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `entries` is the trigger: scroll to the newest line whenever one arrives.
  useEffect(() => {
    const list = listRef.current;
    if (list && open) list.scrollTop = list.scrollHeight;
  }, [entries, open]);

  return (
    <section className={styles.log} aria-labelledby="log-title">
      <header className={styles.header}>
        <h2 id="log-title" className={styles.title}>
          Log
        </h2>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Show"}
        </button>
      </header>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard to scroll it (WCAG 2.1.1) */}
      <ol id={listId} ref={listRef} className={styles.list} role="log" tabIndex={0} hidden={!open}>
        {entries.map((entry) => (
          <li key={entry.id} className={styles.entry} data-who={entry.who}>
            <span className={styles.who}>{WHO[entry.who]} ›</span> {entry.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
