import type { Action, FlyObservation } from "./protocol";

/**
 * Basic strategy when the only choices are hit and stand (no doubling or
 * splitting), for a multi-deck shoe with the dealer standing on all 17s.
 */
export function basicStrategy({ playerSum, dealerCard, usableAce }: FlyObservation): Action {
  const up = dealerCard === 1 ? 11 : dealerCard;
  if (usableAce) {
    if (playerSum >= 19) return "stand";
    if (playerSum === 18) return up <= 8 ? "stand" : "hit";
    return "hit";
  }
  if (playerSum >= 17) return "stand";
  if (playerSum >= 13) return up <= 6 ? "stand" : "hit";
  if (playerSum === 12) return up >= 4 && up <= 6 ? "stand" : "hit";
  return "hit";
}

/** Key of a situation in `FlyStats.cells`: "h16:10" is hard 16 against a dealer 10, "s18:1" soft 18 against an ace. */
export const situationKey = ({ playerSum, dealerCard, usableAce }: FlyObservation) =>
  `${usableAce ? "s" : "h"}${playerSum}:${dealerCard}`;
