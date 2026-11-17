import { useEffect, useId, useState } from "react";
import styles from "./DrunkSlider.module.css";
import { RangeInput } from "./RangeInput";

interface Props {
  /** 0..1 */
  value: number;
  onChange: (value: number) => void;
}

function describe(percent: number): string {
  if (percent === 0) return "sober";
  if (percent < 35) return "tipsy";
  if (percent < 70) return "drunk";
  return "wasted";
}

/** "Pour the fly a drink": scales inhibition up and excitation down in the brain. */
export function DrunkSlider({ value, onChange }: Props) {
  const id = useId();
  const [percent, setPercent] = useState(Math.round(value * 100));

  // Follow the server (e.g. another tab changed it).
  useEffect(() => setPercent(Math.round(value * 100)), [value]);

  const text = `${percent}% · ${describe(percent)}`;

  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        Get the fly drunk
      </label>
      <RangeInput
        id={id}
        min={0}
        max={100}
        step={5}
        value={percent}
        aria-valuetext={text}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          setPercent(next);
          onChange(next / 100);
        }}
      />
      <output htmlFor={id} className={styles.output}>
        {text}
      </output>
    </div>
  );
}
