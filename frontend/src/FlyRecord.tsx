import { type PointerEvent, useState } from "react";
import type { FlyStats } from "../shared/protocol";
import { basicStrategy, situationKey } from "../shared/strategy";
import styles from "./FlyRecord.module.css";

interface Props {
  stats: FlyStats;
  flyNumber: number;
}

/** Dealer up-cards in table order: 2..10, then the ace (sent as 1). */
const DEALER = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];
/** The rows where hitting or standing is a real choice. */
const ROWS = [
  ...[12, 13, 14, 15, 16, 17].map((sum) => ({ sum, soft: false, label: `${sum}` })),
  ...[13, 14, 15, 16, 17, 18].map((sum) => ({ sum, soft: true, label: `A,${sum - 11}` })),
];
/** Hands in the rolling window of the learning curve. */
const WINDOW = 20;
const MIN_HANDS = 5;

const percent = (part: number, whole: number) => (whole ? Math.round((100 * part) / whole) : 0);
const upCard = (dealer: number) => (dealer === 1 ? "A" : String(dealer));

/** Rolling win rate after each hand, once there are enough hands to say anything. */
function learningCurve(recent: number[]): { hand: number; rate: number; window: number }[] {
  const points = [];
  for (let i = MIN_HANDS - 1; i < recent.length; i++) {
    const window = recent.slice(Math.max(0, i + 1 - WINDOW), i + 1);
    points.push({ hand: i + 1, rate: window.filter((r) => r > 0).length / window.length, window: window.length });
  }
  return points;
}

export function FlyRecord({ stats, flyNumber }: Props) {
  const wins = stats.recent.filter((r) => r > 0).length;
  return (
    <section className={styles.panel} aria-labelledby="record-title">
      <header className={styles.header}>
        <h2 id="record-title" className={styles.title}>
          Fly #{flyNumber} vs basic strategy
        </h2>
        <p className={styles.headline}>
          {stats.decisions ? (
            <>
              agrees on <strong>{percent(stats.agreed, stats.decisions)}%</strong> of {stats.decisions} decisions
            </>
          ) : (
            "no decisions yet"
          )}
        </p>
      </header>

      <StrategyGrid stats={stats} />

      <div className={styles.curveHeader}>
        <h3 className={styles.subtitle}>Learning curve</h3>
        <p className={styles.headline}>
          {stats.recent.length ? (
            <>
              won <strong>{percent(wins, stats.recent.length)}%</strong> of the last {stats.recent.length} hands
            </>
          ) : (
            "no hands yet"
          )}
        </p>
      </div>
      <LearningCurve recent={stats.recent} />
    </section>
  );
}

function StrategyGrid({ stats }: { stats: FlyStats }) {
  return (
    <figure className={styles.figure}>
      <table className={styles.grid}>
        <caption className={styles.caption}>
          Each cell is your hand against the dealer's up-card. The letter is what basic strategy does (H hit, S stand);
          the colour is how often the fly did the same.
        </caption>
        <thead>
          <tr>
            <th scope="col">
              <span className={styles.visuallyHidden}>Your hand</span>
            </th>
            {DEALER.map((d) => (
              <th key={d} scope="col">
                {upCard(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={`${row.soft}${row.sum}`} data-first-soft={(row.soft && row.sum === 13) || undefined}>
              <th scope="row">{row.label}</th>
              {DEALER.map((dealerCard) => {
                const observation = { playerSum: row.sum, dealerCard, usableAce: row.soft };
                const book = basicStrategy(observation);
                const [agreed, total] = stats.cells[situationKey(observation)] ?? [0, 0];
                const share = total ? agreed / total : null;
                const verdict =
                  share === null ? "none" : share >= 0.75 ? "agree" : share <= 0.25 ? "disagree" : "mixed";
                const hand = `${row.soft ? "soft" : "hard"} ${row.sum} vs ${upCard(dealerCard)}`;
                const detail = total
                  ? `${hand}: basic strategy says ${book}; the fly did the same ${agreed} of ${total} times`
                  : `${hand}: basic strategy says ${book}; the fly hasn't been here yet`;
                return (
                  <td key={dealerCard} className={styles.cell} data-verdict={verdict} title={detail}>
                    <span aria-hidden="true">{book === "hit" ? "H" : "S"}</span>
                    <span className={styles.visuallyHidden}>{detail}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <figcaption className={styles.legend}>
        <span className={styles.key} data-verdict="agree" /> mostly agrees
        <span className={styles.key} data-verdict="mixed" /> mixed
        <span className={styles.key} data-verdict="disagree" /> mostly disagrees
        <span className={styles.key} data-verdict="none" /> not played
      </figcaption>
    </figure>
  );
}

const W = 320;
const H = 96;
const PAD = { top: 6, right: 6, bottom: 16, left: 30 };

function LearningCurve({ recent }: { recent: number[] }) {
  const points = learningCurve(recent);
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return <p className={styles.empty}>The curve starts after {MIN_HANDS + 1} hands.</p>;
  }

  const first = points[0]?.hand ?? 1;
  const last = points.at(-1)?.hand ?? first + 1;
  const x = (hand: number) => PAD.left + ((hand - first) / (last - first)) * (W - PAD.left - PAD.right);
  const y = (rate: number) => PAD.top + (1 - rate) * (H - PAD.top - PAD.bottom);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.hand).toFixed(1)},${y(p.rate).toFixed(1)}`).join("");
  const shown = hover === null ? null : points[hover];

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const fx = (px - PAD.left) / (W - PAD.left - PAD.right);
    const index = Math.round(fx * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, index)));
  };

  return (
    <figure className={styles.figure}>
      <svg
        className={styles.curve}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Rolling win rate over the last ${WINDOW} hands, from hand ${first} to ${last}; now ${percent(
          (points.at(-1)?.rate ?? 0) * 100,
          100,
        )}%`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {[0, 0.5, 1].map((rate) => (
          <g key={rate}>
            <line className={styles.gridLine} x1={PAD.left} x2={W - PAD.right} y1={y(rate)} y2={y(rate)} />
            <text className={styles.axis} x={PAD.left - 4} y={y(rate)} dy="0.32em" textAnchor="end">
              {rate * 100}%
            </text>
          </g>
        ))}
        <text className={styles.axis} x={PAD.left} y={H - 3}>
          hand {first}
        </text>
        <text className={styles.axis} x={W - PAD.right} y={H - 3} textAnchor="end">
          {last}
        </text>
        <path className={styles.line} d={path} />
        {shown && (
          <g>
            <line className={styles.crosshair} x1={x(shown.hand)} x2={x(shown.hand)} y1={PAD.top} y2={H - PAD.bottom} />
            <circle className={styles.dot} cx={x(shown.hand)} cy={y(shown.rate)} r={4} />
          </g>
        )}
      </svg>
      <figcaption className={styles.readout} aria-live="polite">
        {shown
          ? `hand ${shown.hand}: won ${percent(shown.rate * 100, 100)}% of the last ${shown.window}`
          : `win rate over a rolling window of ${WINDOW} hands`}
      </figcaption>
    </figure>
  );
}
