import { useId } from "react";
import { MAX_BET } from "../shared/bank";
import styles from "./BetPicker.module.css";
import { RangeInput } from "./RangeInput";

interface Props {
  /** Current stake, already capped at the balance. */
  bet: number;
  balance: number;
  minBet: number;
  disabled: boolean;
  onChange: (bet: number) => void;
  onRebuy: () => void;
}

const BASE_CHIPS = [5, 10, 25, 50, 100, 500];
/** Unlocked once you have more than 500: roughly ×2…×2.5 per step, up to a million. */
const HIGH_CHIPS = [1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
const HIGH_STAKES_FROM = 500;
const SLIDER_STEPS = 200;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en-US");

/** Leading digit (1, 2.5 or 5) picks the chip colour. */
const lead = (value: number) => String(value / 10 ** Math.floor(Math.log10(value)));

/** Rounds slider values to amounts a person would bet: 5s below 100, then two significant digits. */
function niceBet(n: number): number {
  if (n < 100) return Math.round(n / 5) * 5;
  const unit = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / unit) * unit;
}

/** The slider is geometric: each step multiplies the bet by the same factor. */
function betFromPosition(position: number, min: number, max: number): number {
  if (position >= SLIDER_STEPS) return max;
  const raw = min * (max / min) ** (position / SLIDER_STEPS);
  return Math.min(max, Math.max(min, niceBet(raw)));
}

function positionFromBet(bet: number, min: number, max: number): number {
  if (max <= min) return SLIDER_STEPS;
  return Math.round((SLIDER_STEPS * Math.log(bet / min)) / Math.log(max / min));
}

export function BetPicker({ bet, balance, minBet, disabled, onChange, onRebuy }: Props) {
  const name = useId();
  const sliderId = useId();

  if (balance < minBet) {
    return (
      <div className={styles.broke}>
        <p className={styles.brokeText}>You're out of chips.</p>
        <button type="button" className={styles.rebuy} disabled={disabled} onClick={onRebuy}>
          Buy back in
        </button>
      </div>
    );
  }

  const maxBet = Math.min(balance, MAX_BET);
  const highStakes = balance > HIGH_STAKES_FROM;
  const chips = [
    ...BASE_CHIPS.filter((value) => value >= minBet),
    ...(highStakes ? HIGH_CHIPS.filter((value) => value <= maxBet) : []),
  ];

  return (
    <fieldset className={styles.picker} disabled={disabled}>
      <legend className={styles.legend}>
        Your bet: <strong className={styles.amount}>{full.format(bet)}</strong>{" "}
        <span className={styles.hint}>· the fly matches it</span>
      </legend>

      <div className={styles.chips}>
        {chips.map((value) => (
          <label
            key={value}
            className={styles.chip}
            data-value={value}
            data-lead={value > HIGH_STAKES_FROM ? lead(value) : undefined}
          >
            <input
              type="radio"
              name={name}
              className={styles.radio}
              value={value}
              checked={bet === value}
              disabled={value > maxBet}
              aria-label={`${full.format(value)} chips`}
              onChange={() => onChange(value)}
            />
            {compact.format(value)}
          </label>
        ))}
        {/* "All in" only when it isn't already one of the chips. */}
        {!chips.includes(maxBet) && (
          <label className={`${styles.chip} ${styles.allIn}`}>
            <input
              type="radio"
              name={name}
              className={styles.radio}
              value={maxBet}
              checked={bet === maxBet}
              onChange={() => onChange(maxBet)}
            />
            All in · {compact.format(maxBet)}
          </label>
        )}
      </div>

      {highStakes && (
        <div className={styles.slider}>
          <label htmlFor={sliderId} className={styles.sliderLabel}>
            Fine-tune
          </label>
          <RangeInput
            id={sliderId}
            min={0}
            max={SLIDER_STEPS}
            value={positionFromBet(bet, minBet, maxBet)}
            aria-valuetext={`${full.format(bet)} chips`}
            onChange={(event) => onChange(betFromPosition(Number(event.currentTarget.value), minBet, maxBet))}
          />
          <span className={styles.sliderRange} aria-hidden="true">
            {compact.format(minBet)} – {compact.format(maxBet)}
          </span>
        </div>
      )}
    </fieldset>
  );
}
