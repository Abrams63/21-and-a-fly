import { describe, expect, test } from "bun:test";
import { basicStrategy, situationKey } from "./strategy";

const play = (playerSum: number, dealerCard: number, usableAce = false) =>
  basicStrategy({ playerSum, dealerCard, usableAce });

describe("basic strategy, hit or stand", () => {
  test("hard hands", () => {
    expect(play(11, 10)).toBe("hit");
    expect([2, 3, 4, 5, 6, 7].map((d) => play(12, d))).toEqual(["hit", "hit", "stand", "stand", "stand", "hit"]);
    expect([2, 6, 7, 10, 1].map((d) => play(16, d))).toEqual(["stand", "stand", "hit", "hit", "hit"]);
    expect(play(17, 1)).toBe("stand");
  });

  test("soft hands", () => {
    expect(play(17, 6, true)).toBe("hit");
    expect([2, 8, 9, 10, 1].map((d) => play(18, d, true))).toEqual(["stand", "stand", "hit", "hit", "hit"]);
    expect(play(19, 10, true)).toBe("stand");
  });

  test("situation keys", () => {
    expect(situationKey({ playerSum: 16, dealerCard: 10, usableAce: false })).toBe("h16:10");
    expect(situationKey({ playerSum: 18, dealerCard: 1, usableAce: true })).toBe("s18:1");
  });
});
