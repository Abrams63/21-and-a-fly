// Bankroll rules and the cookie that keeps balances between visits.

export const START_BALANCE = 100;
export const MIN_BET = 5;
export const MAX_BET = 1_000_000;
export const BANK_COOKIE = "fly21_bank";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface Bank {
  player: number;
  fly: number;
  /** Which fly is at the table: 1 for the first one, +1 for each replacement. */
  flyNumber: number;
  /** Flies you have bankrupted. */
  fliesRuined: number;
  /** Rounds a fly (any of them) finished ahead of you: its payout beat yours. */
  beatenByFlies: number;
  /** Rounds you finished ahead of the fly: your payout beat its. */
  fliesBeaten: number;
}

export interface SavedBank extends Bank {
  /** Last bet you chose. */
  bet: number;
}

export const freshBank = (): SavedBank => ({
  player: START_BALANCE,
  fly: START_BALANCE,
  flyNumber: 1,
  fliesRuined: 0,
  beatenByFlies: 0,
  fliesBeaten: 0,
  bet: 10,
});

/**
 * Rounds up to the next whole unit of the leading digit:
 * 550 → 600, 3400 → 4000, 100 → 100, 99 → 100.
 */
export function roundUpLeading(amount: number): number {
  const n = Math.ceil(amount);
  if (n <= 0) return 0;
  const unit = 10 ** (String(n).length - 1);
  return Math.ceil(n / unit) * unit;
}

/** Bankroll for a fly that replaces a ruined one. */
export const newFlyBalance = (playerBalance: number) => Math.max(MIN_BET, roundUpLeading(playerBalance));

const isCount = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;

/** Reads the bank from a `Cookie` header or `document.cookie`. Falls back to a fresh bank. */
export function readBankCookie(cookieHeader: string | null | undefined): SavedBank {
  const fallback = freshBank();
  if (!cookieHeader) return fallback;
  // Cookie strings are `;`-separated, so they are split by hand (not URLSearchParams).
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== BANK_COOKIE) continue;
    try {
      const data = JSON.parse(decodeURIComponent(part.slice(eq + 1).trim())) as Partial<SavedBank>;
      return {
        player: isCount(data.player) ? data.player : fallback.player,
        fly: isCount(data.fly) ? data.fly : fallback.fly,
        flyNumber: isCount(data.flyNumber, 1) ? data.flyNumber : fallback.flyNumber,
        fliesRuined: isCount(data.fliesRuined) ? data.fliesRuined : fallback.fliesRuined,
        beatenByFlies: isCount(data.beatenByFlies) ? data.beatenByFlies : fallback.beatenByFlies,
        fliesBeaten: isCount(data.fliesBeaten) ? data.fliesBeaten : fallback.fliesBeaten,
        bet: isCount(data.bet, MIN_BET) ? data.bet : fallback.bet,
      };
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export const bankCookieValue = (bank: SavedBank) => encodeURIComponent(JSON.stringify(bank));

export function bankCookie(bank: SavedBank): string {
  return `${BANK_COOKIE}=${bankCookieValue(bank)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

/** Saves the bank in the browser: Cookie Store API where available, `document.cookie` otherwise. */
export function saveBankCookie(bank: SavedBank): void {
  if (typeof cookieStore !== "undefined") {
    cookieStore
      .set({
        name: BANK_COOKIE,
        value: bankCookieValue(bank),
        path: "/",
        sameSite: "lax",
        expires: Date.now() + COOKIE_MAX_AGE * 1000,
      })
      .catch(() => {});
    return;
  }
  // biome-ignore lint/suspicious/noDocumentCookie: fallback where the Cookie Store API is missing (insecure context, older browsers)
  document.cookie = bankCookie(bank);
}
