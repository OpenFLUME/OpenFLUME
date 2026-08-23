/**
 * PickerMenu — a compact "icon + current value" dropdown.
 *
 * Used for the channel picker's sort and filter controls. A native `<select>`
 * would be simpler, but options in one cannot carry the element glyphs that
 * make "filter by branches" recognisable at a glance, and a row of bare
 * toggle buttons does not read as a filter at all. So: a familiar trigger
 * (funnel or sort glyph, plus the value in force) opening a small list whose
 * options carry their own icons.
 *
 * Closes on outside click, on Escape, and on choosing — and restores focus to
 * the trigger, so keyboard users are not dropped at the top of the document.
 */
import React, { useEffect, useRef, useState } from "react";

export interface PickerMenuOption<T extends string> {
  value: T;
  label: string;
  /** Small leading glyph; omitted options simply align with the rest. */
  icon?: React.ReactNode;
}

export interface PickerMenuProps<T extends string> {
  /** Trigger glyph: the funnel or the sort bars. */
  icon: React.ReactNode;
  /** Accessible name of the control ("Filter by element type"). */
  label: string;
  value: T;
  options: ReadonlyArray<PickerMenuOption<T>>;
  onChange: (value: T) => void;
  testId: string;
}

export default function PickerMenu<T extends string>({
  icon,
  label,
  value,
  options,
  onChange,
  testId,
}: PickerMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className="picker-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="picker-menu__trigger"
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? value}`}
        title={`${label}: ${current?.label ?? value}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="picker-menu__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="picker-menu__value">{current?.label ?? value}</span>
        <span className="picker-menu__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul
          className="picker-menu__list"
          role="listbox"
          aria-label={label}
          data-testid={`${testId}-list`}
        >
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={
                  option.value === value
                    ? "picker-menu__option picker-menu__option--active"
                    : "picker-menu__option"
                }
                data-testid={`${testId}-${option.value}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <span className="picker-menu__option-icon" aria-hidden="true">
                  {option.icon}
                </span>
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Funnel: the near-universal "filter" glyph. */
export function FilterIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 3h12l-4.6 5.4v4.1l-2.8 1.4V8.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Descending bars: the near-universal "sort" glyph. */
export function SortIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <g
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M2.5 4h9M2.5 8h6M2.5 12h3" />
      </g>
    </svg>
  );
}
