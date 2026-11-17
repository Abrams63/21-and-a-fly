import { describe, expect, test } from "bun:test";
import type { Card, Rank } from "../../shared/protocol";
import { cardValue, handValue, isBlackjack, Shoe } from "./cards";

const hand = (...ranks: Rank[]): Card[] => ranks.map((rank) => ({ rank, suit: "spades" }));

describe("card values", () => {
  test("faces count 10, aces 1", () => {
    expect(hand("K", "Q", "J", "10", "A", "7").map(cardValue)).toEqual([10, 10, 10, 10, 1, 7]);
  });

  test("an ace counts 11 while it fits", () => {
    expect(handValue(hand("A", "6"))).toEqual({ total: 17, soft: true });
    expect(handValue(hand("A", "6", "9"))).toEqual({ total: 16, soft: false });
    expect(handValue(hand("A", "A", "9"))).toEqual({ total: 21, soft: true });
    expect(handValue(hand("A", "A", "A", "A"))).toEqual({ total: 14, soft: true });
    expect(handValue([])).toEqual({ total: 0, soft: false });
  });

  test("blackjack is 21 with two cards only", () => {
    expect(isBlackjack(hand("A", "K"))).toBe(true);
    expect(isBlackjack(hand("10", "A"))).toBe(true);
    expect(isBlackjack(hand("7", "7", "7"))).toBe(false);
    expect(isBlackjack(hand("A", "9"))).toBe(false);
  });
});

describe("shoe", () => {
  test("holds six full decks and asks for a shuffle when it runs low", () => {
    const shoe = new Shoe();
    const seen = new Map<string, number>();
    let drawn = 0;
    while (!shoe.needsShuffle) {
      const card = shoe.draw();
      const key = `${card.rank}${card.suit}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      drawn++;
    }
    expect(drawn).toBe(6 * 52 - Math.ceil(6 * 52 * 0.25) + 1);
    expect(Math.max(...seen.values())).toBeLessThanOrEqual(6);
  });

  test("never runs dry", () => {
    const shoe = new Shoe(1);
    for (let i = 0; i < 200; i++) expect(shoe.draw()).toBeDefined();
  });
});
