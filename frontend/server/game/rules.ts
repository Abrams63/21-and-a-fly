import type { Card, Outcome } from "../../shared/protocol";
import { cardValue, handValue, isBlackjack } from "./cards";

/**
 * How a finished hand did against the dealer's. `natural` says whether a
 * two-card 21 counts as blackjack: it doesn't after a split.
 */
export function outcome(cards: Card[], dealer: Card[], natural = isBlackjack(cards)): Outcome {
  const p = handValue(cards).total;
  const d = handValue(dealer).total;
  if (p > 21) return "lose";
  const dBj = isBlackjack(dealer);
  if (natural && !dBj) return "win";
  if (dBj && !natural) return "lose";
  if (d > 21 || p > d) return "win";
  return p === d ? "push" : "lose";
}

/** Net result of a bet: blackjack pays 3:2 (rounded up), a win pays 1:1. */
export function netPayout(result: Outcome, bet: number, blackjack: boolean): number {
  if (result === "lose") return -bet;
  if (result === "push") return 0;
  return blackjack ? Math.ceil(bet * 1.5) : bet;
}

/** Two cards of the same value (a ten and a king count) can be split into two hands. */
export function canSplitCards(cards: Card[]): boolean {
  const [a, b] = cards;
  return cards.length === 2 && a !== undefined && b !== undefined && cardValue(a) === cardValue(b);
}
