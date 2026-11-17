import type { SeatScore, TableState } from "../shared/protocol";
import { InfoTip } from "./InfoTip";
import styles from "./Scoreboard.module.css";

interface Props {
  state: TableState;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function record({ win, lose, push }: SeatScore): string {
  return `${plural(win, "win", "wins")} · ${plural(lose, "loss", "losses")} · ${plural(push, "push", "pushes")}`;
}

export function Scoreboard({ state }: Props) {
  const { bank, score, brain } = state;
  const rows = [
    { id: "player", name: "You", balance: bank.player, score: score.player },
    { id: "fly", name: `Fly #${bank.flyNumber}`, balance: bank.fly, score: score.fly },
  ] as const;

  return (
    <dl className={styles.board}>
      {rows.map((row) => (
        <div key={row.id} className={styles.row} data-seat={row.id}>
          <dt className={styles.name}>{row.name}</dt>
          <dd className={styles.value}>
            <span className={styles.balance}>
              {row.balance.toLocaleString("en-US")}
              <span className={styles.unit}> chips</span>
            </span>
            <span className={styles.detail}>{record(row.score)}</span>
          </dd>
        </div>
      ))}
      <div className={styles.row} data-seat="ruined">
        <dt className={styles.name}>
          Flies ruined
          <InfoTip label="About flies ruined">
            <strong>Flies ruined</strong>: flies you bankrupted. When a fly can't match your bet it is shooed off the
            table and a new one sits down.
            <br />
            Fly #{bank.flyNumber} has learned from <strong>{brain.episodes.toLocaleString("en-US")}</strong> hands.
          </InfoTip>
        </dt>
        <dd className={styles.value}>
          <span className={styles.balance}>{bank.fliesRuined}</span>
        </dd>
      </div>
      <div className={styles.row} data-seat="duel">
        <dt className={styles.name}>
          You vs flies
          <InfoTip label="About you vs flies">
            <strong>You vs flies</strong>: rounds where your payout beat the fly's, and rounds where the fly's beat
            yours. Equal payouts count for nobody. The score carries over from fly to fly.
          </InfoTip>
        </dt>
        <dd className={styles.value}>
          <span className={styles.balance}>
            <span className={styles.visuallyHidden}>
              you {bank.fliesBeaten}, flies {bank.beatenByFlies}
            </span>
            <span aria-hidden="true">
              <span className={styles.you}>{bank.fliesBeaten.toLocaleString("en-US")}</span>
              <span className={styles.colon}>:</span>
              <span className={styles.flies}>{bank.beatenByFlies.toLocaleString("en-US")}</span>
            </span>
          </span>
        </dd>
      </div>
    </dl>
  );
}
