import { describe, expect, test } from "bun:test";
import { BANK_COOKIE, bankCookieValue, freshBank, newFlyBalance, readBankCookie, roundUpLeading } from "./bank";

describe("bank", () => {
  test("rounds up to the next unit of the leading digit", () => {
    expect([0, 99, 100, 101, 550, 3400, 3401].map(roundUpLeading)).toEqual([0, 100, 100, 200, 600, 4000, 4000]);
  });

  test("a new fly gets at least the minimum bet", () => {
    expect(newFlyBalance(0)).toBe(5);
    expect(newFlyBalance(130)).toBe(200);
  });

  test("a fresh bank has a random player id", () => {
    const a = freshBank();
    const b = freshBank();
    expect(a.id).toMatch(/^[0-9a-f]{20}$/);
    expect(a.id).not.toBe(b.id);
  });

  test("reads its own cookie back", () => {
    const bank = { ...freshBank(), player: 340, fly: 12, flyNumber: 3, bet: 50 };
    const header = `other=1; ${BANK_COOKIE}=${bankCookieValue(bank)}; theme=dark`;
    expect(readBankCookie(header)).toEqual(bank);
  });

  test("falls back field by field on bad values", () => {
    const value = encodeURIComponent(JSON.stringify({ id: "<script>", player: -5, fly: 1.5, flyNumber: 0, bet: 2 }));
    const bank = readBankCookie(`${BANK_COOKIE}=${value}`);
    expect(bank.id).toMatch(/^[0-9a-f]{20}$/);
    expect(bank).toMatchObject({ player: 100, fly: 100, flyNumber: 1, bet: 10 });
    expect(readBankCookie(`${BANK_COOKIE}=%7Bbroken`).player).toBe(100);
    expect(readBankCookie(null).player).toBe(100);
  });
});
