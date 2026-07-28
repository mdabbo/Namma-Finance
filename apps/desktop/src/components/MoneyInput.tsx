import { useEffect, useState, type InputHTMLAttributes } from "react";
import { currencyInfo } from "@mep/core";
import { minorToInput, parseToMinor } from "../lib/format";
import { Input, cx } from "./ui";

interface MoneyInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "inputMode"> {
  valueMinor: number | null;
  onChange: (minor: number | null) => void;
  currency?: string;
}

/** Text field that edits integer minor units as a human decimal amount. */
export function MoneyInput({
  valueMinor,
  onChange,
  currency = "EGP",
  className,
  placeholder,
  disabled,
  "aria-invalid": ariaInvalid,
  ...inputProps
}: MoneyInputProps) {
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
        aria-invalid={ariaInvalid ?? invalid}
        placeholder={placeholder ?? "0.00"}
        className="pe-14 text-end tnum"
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
        {...inputProps}
      />
      <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs font-medium text-muted">
        {currency}
      </span>
    </div>
  );
}
