import type { Card, Outcome } from "../../shared/protocol";
import { handValue, isBlackjack } from "./cards";

/** How a finished hand did against the dealer's. */
export function outcome(cards: Card[], dealer: Card[]): Outcome {
  const p = handValue(cards).total;
  const d = handValue(dealer).total;
  if (p > 21) return "lose";
  const pBj = isBlackjack(cards);
  const dBj = isBlackjack(dealer);
  if (pBj && !dBj) return "win";
  if (dBj && !pBj) return "lose";
  if (d > 21 || p > d) return "win";
  return p === d ? "push" : "lose";
}

/** Net result of a bet: blackjack pays 3:2 (rounded up), a win pays 1:1. */
export function netPayout(result: Outcome, bet: number, blackjack: boolean): number {
  if (result === "lose") return -bet;
  if (result === "push") return 0;
  return blackjack ? Math.ceil(bet * 1.5) : bet;
}
