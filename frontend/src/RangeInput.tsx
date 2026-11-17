import type { CSSProperties, InputHTMLAttributes } from "react";
import styles from "./RangeInput.module.css";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "min" | "max" | "value"> {
  min: number;
  max: number;
  value: number;
}

/** Native `<input type="range">` with a branded track; the filled part follows the value. */
export function RangeInput({ min, max, value, className, style, ...rest }: Props) {
  const vars = {
    "--attr-min": min,
    "--attr-max": max,
    "--control-value": value,
    ...style,
  } as CSSProperties;

  return (
    <input
      {...rest}
      type="range"
      min={min}
      max={max}
      value={value}
      className={className ? `${styles.slider} ${className}` : styles.slider}
      style={vars}
    />
  );
}
