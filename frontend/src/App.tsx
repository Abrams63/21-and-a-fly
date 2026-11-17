import styles from "./App.module.css";
import { BrainPanel } from "./BrainPanel";
import { FlyRecord } from "./FlyRecord";
import { GameLog } from "./GameLog";
import { Scoreboard } from "./Scoreboard";
import { Table } from "./Table";
import { useGame } from "./useGame";
import { useTableSounds } from "./useTableSounds";

const STATUS_TEXT = {
  connecting: "Connecting…",
  open: "",
  closed: "Offline, reconnecting…",
} as const;

export function App() {
  const { state, topology, log, status, error, eviction, stats, bet, setBet, send, activity } = useGame();
  const sound = useTableSounds(state, eviction);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.visuallyHidden}>21 and Fly</h1>
        {state && <Scoreboard state={state} />}
        <button
          type="button"
          className={styles.soundToggle}
          aria-pressed={sound.enabled}
          onClick={sound.toggle}
          title={sound.enabled ? "Mute table sounds and vibration" : "Turn table sounds and vibration on"}
        >
          {sound.enabled ? "♪ sound on" : "♪ sound off"}
        </button>
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
          {state && stats && <FlyRecord stats={stats} flyNumber={state.bank.flyNumber} />}
        </aside>
      </main>
    </div>
  );
}
