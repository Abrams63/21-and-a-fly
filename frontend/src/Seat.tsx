import type { ReactNode } from "react";
import type { HandStatus, HandView, Outcome } from "../shared/protocol";
import { PlayingCard } from "./PlayingCard";
import styles from "./Seat.module.css";

interface Props {
  title: string;
  subtitle?: string;
  hand: HandView;
  active: boolean;
  result?: Outcome;
  /** Chips on the table this round. */
  bet?: number;
  /** Net win/loss once the round is settled. */
  payout?: number;
  variant?: "plain" | "dish";
  avatar?: ReactNode;
  /** Shown on top of the seat, e.g. when the fly is replaced. */
  overlay?: ReactNode;
}

const STATUS_TEXT: Partial<Record<HandStatus, string>> = {
  bust: "bust",
  blackjack: "blackjack",
  stood: "stand",
};

const RESULT_TEXT: Record<Outcome, string> = {
  win: "win",
  lose: "loss",
  push: "push",
};

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");

export function Seat(props: Props) {
  const { title, subtitle, hand, active, result, bet, payout, variant = "plain", avatar, overlay } = props;
  const status = STATUS_TEXT[hand.status];

  return (
    <article
      className={styles.seat}
      data-variant={variant}
      data-active={active || undefined}
      data-result={result}
      aria-label={title}
    >
      <header className={styles.header}>
        {avatar}
        <div className={styles.names}>
          <h2 className={styles.title}>{title}</h2>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        <p className={styles.total}>
          <span className={styles.visuallyHidden}>Points: </span>
          {hand.total ?? "—"}
          {hand.soft && hand.total !== 21 && <span className={styles.soft}>soft</span>}
        </p>
      </header>

      <ul className={styles.cards} aria-label="Cards">
        {hand.cards.map((card, i) => (
          <li key={card ? `${i}-${card.rank}-${card.suit}` : `${i}-back`} className={styles.slot}>
            <PlayingCard card={card} index={i} />
          </li>
        ))}
      </ul>

      <footer className={styles.footer}>
        {bet !== undefined && <span className={styles.bet}>bet {bet}</span>}
        {status && (
          <span className={styles.status} data-status={hand.status}>
            {status}
          </span>
        )}
        {result && (
          <strong className={styles.result} data-result={result}>
            {RESULT_TEXT[result]}
            {payout !== undefined && ` ${signed(payout)}`}
          </strong>
        )}
      </footer>

      {overlay}
    </article>
  );
}
