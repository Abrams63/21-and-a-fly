import { describe, expect, test } from "bun:test";
import type { Card, Rank } from "../../shared/protocol";
import { netPayout, outcome } from "./rules";

const hand = (...ranks: Rank[]): Card[] => ranks.map((rank) => ({ rank, suit: "hearts" }));

describe("outcome", () => {
  test("higher total wins, equal totals push", () => {
    expect(outcome(hand("10", "9"), hand("10", "8"))).toBe("win");
    expect(outcome(hand("10", "7"), hand("10", "8"))).toBe("lose");
    expect(outcome(hand("10", "8"), hand("9", "9"))).toBe("push");
  });

  test("a bust loses even when the dealer busts too", () => {
    expect(outcome(hand("10", "6", "9"), hand("10", "6", "8"))).toBe("lose");
    expect(outcome(hand("10", "6"), hand("10", "6", "8"))).toBe("win");
  });

  test("a natural beats a three-card 21, two naturals push", () => {
    expect(outcome(hand("A", "K"), hand("7", "7", "7"))).toBe("win");
    expect(outcome(hand("7", "7", "7"), hand("A", "K"))).toBe("lose");
    expect(outcome(hand("A", "Q"), hand("K", "A"))).toBe("push");
  });
});

describe("payout", () => {
  test("a win pays 1:1, a loss costs the bet, a push returns it", () => {
    expect(netPayout("win", 10, false)).toBe(10);
    expect(netPayout("lose", 10, false)).toBe(-10);
    expect(netPayout("push", 10, false)).toBe(0);
  });

  test("blackjack pays 3:2, rounded up in the player's favour", () => {
    expect(netPayout("win", 10, true)).toBe(15);
    expect(netPayout("win", 5, true)).toBe(8);
    expect(netPayout("push", 10, true)).toBe(0);
  });
});
