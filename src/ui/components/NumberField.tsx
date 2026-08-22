import React from "react";
import { formatNumber } from "../units";

interface NumberFieldProps {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Optional suffix shown after the label, e.g. a unit note. */
  unitNote?: string;
  /** Accessible name when the visible label is ambiguous — e.g. the same
   *  parameter rendered once per fluid card. */
  ariaLabel?: string;
  dataTestId?: string;
}

/**
 * Plain numeric field with UnitInput-style commit semantics: the user edits
 * a local raw string and the value is written to the store only on blur or
 * Enter — no intermediate 0/undefined states from per-keystroke parseFloat.
 * No unit conversion (use UnitInput for physical quantities).
 */
export default function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  disabled,
  unitNote,
  ariaLabel,
  dataTestId,
}: NumberFieldProps) {
  const id = React.useId();
  const [raw, setRaw] = React.useState("");
  const [focused, setFocused] = React.useState(false);

  const rawRef = React.useRef(raw);
  const focusedRef = React.useRef(focused);
  const onChangeRef = React.useRef(onChange);
  const valueRef = React.useRef(value);
  const cancelBlurRef = React.useRef(false);
  React.useEffect(() => {
    rawRef.current = raw;
  }, [raw]);
  React.useEffect(() => {
    focusedRef.current = focused;
  }, [focused]);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  React.useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const displayValue = focused
    ? raw
    : value === undefined || value === null || !isFinite(value)
      ? ""
      : formatNumber(value);

  React.useEffect(() => {
    if (!focused && value !== undefined && value !== null && isFinite(value)) {
      setRaw(String(value));
    }
  }, [value, focused]);

  const commit = React.useCallback(() => {
    setFocused(false);
    focusedRef.current = false;
    if (cancelBlurRef.current) {
      cancelBlurRef.current = false;
      return;
    }
    const r = rawRef.current.trim();
    if (r === "" || r === "-") {
      if (valueRef.current !== undefined) onChangeRef.current(undefined);
      return;
    }
    const parsed = Number(r);
    if (Number.isFinite(parsed) && parsed !== valueRef.current)
      onChangeRef.current(parsed);
  }, []);

  // Commit on unmount too, so an in-flight edit is never lost.
  React.useEffect(() => {
    return () => {
      if (!focusedRef.current) return;
      const r = rawRef.current.trim();
      if (r === "" || r === "-") {
        if (valueRef.current !== undefined) onChangeRef.current(undefined);
      } else {
        const parsed = Number(r);
        if (Number.isFinite(parsed) && parsed !== valueRef.current)
          onChangeRef.current(parsed);
      }
    };
  }, []);

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {unitNote ? (
          <>
            {" "}
            <span className="field__unit">({unitNote})</span>
          </>
        ) : null}
      </label>
      <input
        id={id}
        data-testid={dataTestId}
        className="input"
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        disabled={disabled}
        step={step}
        min={min}
        max={max}
        value={displayValue}
        onFocus={() => {
          setFocused(true);
          if (value !== undefined && value !== null && isFinite(value)) {
            setRaw(String(value));
          }
        }}
        onBlur={commit}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            cancelBlurRef.current = true;
            focusedRef.current = false;
            setFocused(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}
