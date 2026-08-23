import React from "react";
import { useStore } from "../store";
import {
  QuantityKind,
  convertToSI,
  convertFromSI,
  formatNumber,
  getUnitDef,
} from "../units";

interface UnitInputProps {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: number;
  quantityKind: QuantityKind;
  disabled?: boolean;
  dataTestId?: string;
}

export default function UnitInput({
  label,
  value,
  onChange,
  step = 1,
  quantityKind,
  disabled,
  dataTestId,
}: UnitInputProps) {
  const id = React.useId();
  const unitId = useStore((s) => s.unitPreferences[quantityKind]);
  const unit = getUnitDef(quantityKind, unitId);
  const [raw, setRaw] = React.useState("");
  const [focused, setFocused] = React.useState(false);

  const rawRef = React.useRef(raw);
  const focusedRef = React.useRef(focused);
  const onChangeRef = React.useRef(onChange);
  const valueRef = React.useRef(value);
  const cancelBlurRef = React.useRef(false);
  const unitIdRef = React.useRef(unitId);
  const kindRef = React.useRef(quantityKind);

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
  React.useEffect(() => {
    unitIdRef.current = unitId;
  }, [unitId]);
  React.useEffect(() => {
    kindRef.current = quantityKind;
  }, [quantityKind]);

  const displayValue = React.useMemo(() => {
    if (focused) return raw;
    if (value === undefined || value === null || !isFinite(value)) return "";
    return formatNumber(convertFromSI(quantityKind, value, unitId));
  }, [focused, raw, value, quantityKind, unitId]);

  React.useEffect(() => {
    if (!focused && value !== undefined && value !== null && isFinite(value)) {
      setRaw(String(convertFromSI(quantityKind, value, unitId)));
    }
  }, [value, quantityKind, unitId, focused]);

  const commit = React.useCallback(() => {
    setFocused(false);
    focusedRef.current = false;
    if (cancelBlurRef.current) {
      cancelBlurRef.current = false;
      return;
    }
    const r = rawRef.current;
    if (r === "" || r.trim() === "" || r.trim() === "-") {
      if (valueRef.current !== undefined) onChangeRef.current(undefined);
      return;
    }
    const parsed = Number(r);
    if (Number.isFinite(parsed)) {
      const next = convertToSI(kindRef.current, parsed, unitIdRef.current);
      if (next !== valueRef.current) onChangeRef.current(next);
    }
  }, []);

  React.useEffect(() => {
    return () => {
      if (focusedRef.current) {
        const r = rawRef.current;
        if (r === "" || r.trim() === "" || r.trim() === "-") {
          if (valueRef.current !== undefined) onChangeRef.current(undefined);
        } else {
          const parsed = Number(r);
          if (Number.isFinite(parsed)) {
            const next = convertToSI(
              kindRef.current,
              parsed,
              unitIdRef.current,
            );
            if (next !== valueRef.current) onChangeRef.current(next);
          }
        }
      }
    };
  }, []);

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label} <span className="field__unit">({unit.symbol})</span>
      </label>
      <input
        id={id}
        data-testid={dataTestId}
        className="input"
        type="text"
        inputMode="decimal"
        disabled={disabled}
        step={step}
        value={displayValue}
        onFocus={() => {
          setFocused(true);
          if (value !== undefined && value !== null && isFinite(value)) {
            setRaw(String(convertFromSI(quantityKind, value, unitId)));
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
