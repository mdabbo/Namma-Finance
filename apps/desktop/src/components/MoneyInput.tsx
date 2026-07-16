import { useEffect, useState } from "react";
import { currencyInfo } from "@mep/core";
import { minorToInput, parseToMinor } from "../lib/format";
import { Input, cx } from "./ui";

interface MoneyInputProps {
  valueMinor: number | null;
  onChange: (minor: number | null) => void;
  currency?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

/** Text field that edits integer minor units as a human decimal amount. */
export function MoneyInput({ valueMinor, onChange, currency = "EGP", className, placeholder, disabled }: MoneyInputProps) {
  const exponent = currencyInfo(currency).exponent;
  const [text, setText] = useState(() => minorToInput(valueMinor, exponent));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    // resync when the outside value changes (e.g. form reset)
    setText((prev) => {
      const prevMinor = parseToMinor(prev, exponent);
      return prevMinor === valueMinor ? prev : minorToInput(valueMinor, exponent);
    });
  }, [valueMinor, exponent]);

  return (
    <div className={cx("relative", className)}>
      <Input
        inputMode="decimal"
        dir="ltr"
        value={text}
        disabled={disabled}
        placeholder={placeholder ?? "0.00"}
        className={cx("pe-14 text-end tnum", invalid && "!border-red-400")}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw.trim() === "") {
            setInvalid(false);
            onChange(null);
            return;
          }
          const minor = parseToMinor(raw, exponent);
          setInvalid(minor === null);
          if (minor !== null) onChange(minor);
        }}
      />
      <span className="pointer-events-none absolute end-3 top-1.5 text-xs font-medium text-slate-400">{currency}</span>
    </div>
  );
}
