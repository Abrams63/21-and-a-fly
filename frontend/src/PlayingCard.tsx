import type { CSSProperties } from "react";
import type { Card, Rank, Suit } from "../shared/protocol";
import styles from "./PlayingCard.module.css";

const SUIT_SYMBOL: Record<Suit, string> = { spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" };
const SUIT_NAME: Record<Suit, string> = { spades: "spades", hearts: "hearts", diamonds: "diamonds", clubs: "clubs" };
const RANK_NAME: Partial<Record<Rank, string>> = { A: "Ace", K: "King", Q: "Queen", J: "Jack" };

interface Props {
  /** `null` renders the card face down. */
  card: Card | null;
  /** Position in the hand, used to stagger the deal animation. */
  index: number;
}

export function PlayingCard({ card, index }: Props) {
  const style = { "--i": index } as CSSProperties;

  if (!card) {
    return <div className={styles.card} data-face="down" style={style} role="img" aria-label="Face-down card" />;
  }

  const symbol = SUIT_SYMBOL[card.suit];
  const red = card.suit === "hearts" || card.suit === "diamonds";
  const label = `${RANK_NAME[card.rank] ?? card.rank} of ${SUIT_NAME[card.suit]}`;

  return (
    <div className={styles.card} data-face="up" data-red={red || undefined} style={style} role="img" aria-label={label}>
      <span className={styles.corner} aria-hidden="true">
        {card.rank}
        <br />
        {symbol}
      </span>
      <span className={styles.pip} aria-hidden="true">
        {symbol}
      </span>
      <span className={`${styles.corner} ${styles.cornerEnd}`} aria-hidden="true">
        {card.rank}
        <br />
        {symbol}
      </span>
    </div>
  );
}
