import styles from "./App.module.css";
import { BrainPanel } from "./BrainPanel";
import { GameLog } from "./GameLog";
import { Scoreboard } from "./Scoreboard";
import { Table } from "./Table";
import { useGame } from "./useGame";

const STATUS_TEXT = {
  connecting: "Connecting…",
  open: "",
  closed: "Offline, reconnecting…",
} as const;

export function App() {
  const { state, topology, log, status, error, eviction, bet, setBet, send, activity } = useGame();

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.visuallyHidden}>21 and Fly</h1>
        {state && <Scoreboard state={state} />}
      </header>

      {/* Only shown while the connection is down. */}
      <p className={styles.connection} data-status={status} role="status" hidden={status === "open"}>
        {STATUS_TEXT[status]}
      </p>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <main className={styles.main}>
        {state ? (
          <Table state={state} eviction={eviction} bet={bet} onBetChange={setBet} send={send} />
        ) : (
          <p className={styles.placeholder}>Setting the table…</p>
        )}
        <aside className={styles.side}>
          <GameLog entries={log} />
          {state && topology && <BrainPanel topology={topology} activity={activity} state={state} send={send} />}
        </aside>
      </main>
    </div>
  );
}
