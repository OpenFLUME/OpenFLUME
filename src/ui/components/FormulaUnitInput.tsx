/**
 * FormulaUnitInput — UnitInput-compatible editor for the formula-bindable
 * (`NumberOrExpression`) allowlist fields of core/schema.ts.
 *
 * Literal behaviour is byte-for-byte the UnitInput contract: local raw text,
 * commit on blur/Enter/unmount, SI conversion through the field's unit
 * preference.  On top of that:
 *
 *  - Text beginning with `=` commits `{ expr: <text without => }` instead of
 *    a number (e.g. `=pipe('seg1').surfaceArea`).
 *  - The default editor is the VISUAL chip editor (FormulaExpressionEditor):
 *    model references render as inline token chips with autocomplete;
 *    the raw source string stays authoritative and byte-exact. The
 *    "f(x)" button opens a click-first browser of complete references
 *    and functions (entering formula mode first on a literal field); an
 *    "Aa" (Text formula) toggle switches to the plain-text input (the
 *    pre-chips editing path) at any time — both edit the same source.
 *  - A formula-bound field shows an ƒ badge, keeps the expression editable
 *    (editor text is `=<expr>`), and shows a resolved preview in the current
 *    display unit (`→ 0.152 m²`) under the input.
 *  - Parse/dependency/range errors render inline (role="alert") WITHOUT
 *    deleting or reverting the stored formula.
 *  - "Use resolved value" writes the resolved number back as a plain
 *    literal — one ordinary config update (one undo step).
 *
 * Previews come exclusively from core's previewNetworkParameters (pure — no
 * config/history mutation); see ui/formulaBinding.ts.
 */
import React from "react";
import { useStore } from "../store";
import {
  QuantityKind,
  convertToSI,
  convertFromSI,
  formatNumber,
  getUnitDef,
} from "../units";
import {
  FORMULA_SCOPE_HELP,
  FORMULA_SEMANTICS_HELP,
  expressionParseError,
  isFormulaBound,
  parseFormulaInput,
  previewBoundField,
  type BindableValue,
} from "../formulaBinding";
import { formulaCatalogForConfig } from "../formulaCompletion";
import FormulaExpressionEditor, {
  type FormulaExpressionEditorHandle,
} from "./FormulaExpressionEditor";
import FormulaBrowser from "./FormulaBrowser";

interface FormulaUnitInputProps {
  label: string;
  /** Stored value: literal SI number, `{ expr }`, or undefined (unset). */
  value: BindableValue;
  /** Commit the next value — one ordinary config update per call. */
  onChange: (v: number | { expr: string } | undefined) => void;
  step?: number;
  /**
   * Physical quantity for display-unit conversion.  Pass undefined for a
   * plain SI number with no unit system entry (e.g. UA in W/K) — `unitNote`
   * then supplies the label suffix.
   */
  quantityKind?: QuantityKind;
  /** Label suffix when quantityKind is undefined (e.g. "W/K"). */
  unitNote?: string;
  /**
   * Readable field path used by core/paramBindings as the `resolved` key /
   * error prefix, e.g. "branch 'seg1'.diameter" — required so the preview
   * can find this field's value and filter this field's errors.
   */
  path: string;
  disabled?: boolean;
  dataTestId?: string;
  /** Bindable fields are geometry-like: warn when the resolved value is not
   *  positive (core validate.ts remains the authority).  Default true. */
  requirePositive?: boolean;
  /**
   * What an expression committed here means.  'static' (the default) is a
   * parameter binding: resolved once before each solve and previewed inline.
   * 'runtime' means the SOLVER evaluates the source on its own cadence from a
   * scope only it has (a convection h equation over Re/Pr/G/… —
   * core/correlations.ts), so there is no static value to resolve, preview or
   * range-check here; the owning editor documents that scope instead.
   */
  semantics?: "static" | "runtime";
}

export default function FormulaUnitInput({
  label,
  value,
  onChange,
  step = 1,
  quantityKind,
  unitNote,
  path,
  disabled,
  dataTestId,
  requirePositive = true,
  semantics = "static",
}: FormulaUnitInputProps) {
  const runtimeSemantics = semantics === "runtime";
  const id = React.useId();
  const config = useStore((s) => s.config);
  const unitId = useStore((s) =>
    quantityKind ? s.unitPreferences[quantityKind] : "-",
  );
  const unit = quantityKind ? getUnitDef(quantityKind, unitId) : null;

  const bound = isFormulaBound(value);

  const [raw, setRaw] = React.useState("");
  const [focused, setFocused] = React.useState(false);
  /** Plain-text fallback: the ordinary input editing path (no chips). */
  const [plainText, setPlainText] = React.useState(false);
  const [browserAnchor, setBrowserAnchor] = React.useState<DOMRect | null>(
    null,
  );

  /** Completion catalog for the chip editor (validity + autocomplete). */
  const catalog = React.useMemo(
    () => formulaCatalogForConfig(config),
    [config],
  );

  const editorRef = React.useRef<FormulaExpressionEditorHandle>(null);
  const insertButtonRef = React.useRef<HTMLButtonElement>(null);
  /** Set when Formula Options was clicked in plain-text mode: open the browser once the
   *  visual editor has remounted. */
  const pickerPendingRef = React.useRef(false);

  const rawRef = React.useRef(raw);
  const focusedRef = React.useRef(focused);
  const onChangeRef = React.useRef(onChange);
  const unitIdRef = React.useRef(unitId);
  const kindRef = React.useRef(quantityKind);
  const valueRef = React.useRef(value);

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
    unitIdRef.current = unitId;
  }, [unitId]);
  React.useEffect(() => {
    kindRef.current = quantityKind;
  }, [quantityKind]);
  React.useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const toSI = React.useCallback(
    (display: number) =>
      kindRef.current
        ? convertToSI(kindRef.current, display, unitIdRef.current)
        : display,
    [],
  );
  const fromSI = React.useCallback(
    (si: number) =>
      quantityKind ? convertFromSI(quantityKind, si, unitId) : si,
    [quantityKind, unitId],
  );

  const textOf = React.useCallback(
    (v: BindableValue): string => {
      if (isFormulaBound(v)) return `=${v.expr}`;
      if (typeof v === "number" && Number.isFinite(v))
        return formatNumber(fromSI(v));
      return "";
    },
    [fromSI],
  );

  const displayValue = focused ? raw : textOf(value);

  React.useEffect(() => {
    if (!focused) setRaw(textOf(value));
  }, [value, focused, textOf]);

  /** Parse + commit raw text.  Returns without committing when a literal
   *  fails to parse (UnitInput semantics) — but a formula ALWAYS commits,
   *  even with a parse error, so a typo never destroys the typed source
   *  (the error shows inline and validate.ts reports it). */
  const commitRaw = React.useCallback(
    (r: string) => {
      const parsed = parseFormulaInput(r);
      if (
        parsed.kind === "empty" ||
        (parsed.kind === "literal" &&
          (parsed.text === "" || parsed.text === "-"))
      ) {
        onChangeRef.current(undefined);
        return;
      }
      if (parsed.kind === "formula") {
        const prev = valueRef.current;
        if (!isFormulaBound(prev) || prev.expr !== parsed.expr) {
          onChangeRef.current({ expr: parsed.expr });
        }
        return;
      }
      const num = parseFloat(parsed.text);
      if (Number.isNaN(num)) return;
      const si = toSI(num);
      if (si !== valueRef.current) onChangeRef.current(si);
    },
    [toSI],
  );

  /**
   * Commit the in-flight edit.  `overrideText` carries the exact text for
   * edits committed without focus (chip remove in display mode), where the
   * raw state has not caught up; otherwise the local raw text is used.
   */
  const commit = React.useCallback(
    (overrideText?: string) => {
      setFocused(false);
      commitRaw(
        typeof overrideText === "string" ? overrideText : rawRef.current,
      );
    },
    [commitRaw],
  );

  /** Focus entry shared by the plain input and the chip editor.  The chip
   *  editor can re-focus around programmatic edits, so only reset the raw
   *  text on a genuine unfocused → focused transition. */
  const handleFocus = React.useCallback(() => {
    if (!focusedRef.current) setRaw(textOf(valueRef.current));
    setFocused(true);
  }, [textOf]);

  // Commit on unmount too, so an in-flight edit is never lost.
  React.useEffect(() => {
    return () => {
      if (focusedRef.current) commitRaw(rawRef.current);
    };
  }, [commitRaw]);

  /**
   * Formula options. The browser inserts complete references into the visual editor:
   * from the plain-text fallback we switch back first and open the picker
   * once the editor has remounted.  In the visual editor the editor itself
   * handles formula-mode entry (a literal source becomes the '=' leader)
   * and focuses/opens the menu at the caret or append position.
   */
  const handleInsertVariable = React.useCallback(() => {
    if (disabled) return;
    if (plainText) {
      pickerPendingRef.current = true;
      setPlainText(false);
      return;
    }
    editorRef.current?.beginFormula();
    const rect = insertButtonRef.current?.getBoundingClientRect();
    if (rect) setBrowserAnchor(rect);
  }, [disabled, plainText]);

  React.useEffect(() => {
    if (plainText || !pickerPendingRef.current) return;
    pickerPendingRef.current = false;
    editorRef.current?.beginFormula();
    const rect = insertButtonRef.current?.getBoundingClientRect();
    if (rect) setBrowserAnchor(rect);
  }, [plainText]);

  /* ---------- formula preview (committed binding only) ---------- */

  const preview = React.useMemo(() => {
    if (!bound || runtimeSemantics) return null;
    return previewBoundField(config, path);
  }, [bound, runtimeSemantics, config, path]);

  // Candidate parse feedback while editing a not-yet-committed formula.
  const candidateError = React.useMemo(() => {
    if (!focused) return null;
    const parsed = parseFormulaInput(raw);
    if (parsed.kind !== "formula") return null;
    return expressionParseError(parsed.expr);
  }, [focused, raw]);

  const numericPreview =
    bound && preview?.status === "ok" ? preview.value : undefined;
  const rangeWarning =
    numericPreview !== undefined && requirePositive && !(numericPreview > 0)
      ? `Resolved value ${formatNumber(numericPreview)} must be positive for ${label}.`
      : null;

  const useResolved = () => {
    if (numericPreview !== undefined) onChange(numericPreview);
  };

  const symbol = unit ? unit.symbol : unitNote;

  return (
    <div className="field formula-unit-input" data-testid={dataTestId}>
      <div className="formula-unit-input__header">
        <label className="field__label" htmlFor={id}>
          {label}
          {symbol ? (
            <>
              {" "}
              <span className="field__unit">({symbol})</span>
            </>
          ) : null}
        </label>
        <div className="formula-unit-input__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm formula-unit-input__toggle"
            data-testid={dataTestId ? `${dataTestId}-plain-toggle` : undefined}
            aria-pressed={plainText}
            aria-label="Text formula"
            disabled={disabled}
            title={
              plainText
                ? "Text formula is on. Click to return to the visual editor."
                : "Edit the formula source as plain text"
            }
            onClick={() => setPlainText((v) => !v)}
          >
            Aa
          </button>
          <button
            ref={insertButtonRef}
            type="button"
            className="btn btn--ghost btn--sm formula-unit-input__insert"
            data-testid={
              dataTestId ? `${dataTestId}-insert-variable` : undefined
            }
            aria-label={`Browse formula options for ${label}`}
            aria-haspopup="dialog"
            aria-expanded={browserAnchor !== null}
            disabled={disabled}
            title="Browse model values and functions; formula syntax is inserted automatically"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleInsertVariable}
          >
            f(x)
          </button>
        </div>
      </div>
      <div className="formula-unit-input__control">
        {plainText ? (
          <input
            id={id}
            className="input"
            type="text"
            inputMode="decimal"
            disabled={disabled}
            step={step}
            value={displayValue}
            data-testid={dataTestId ? `${dataTestId}-input` : undefined}
            aria-invalid={
              candidateError !== null ||
              preview?.status === "error" ||
              rangeWarning !== null ||
              undefined
            }
            onFocus={handleFocus}
            onBlur={() => commit()}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commit();
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        ) : (
          <FormulaExpressionEditor
            ref={editorRef}
            id={id}
            text={displayValue}
            catalog={catalog}
            disabled={disabled}
            ariaLabel={`${label}${symbol ? ` (${symbol})` : ""}`}
            ariaInvalid={
              candidateError !== null ||
              preview?.status === "error" ||
              rangeWarning !== null
            }
            dataTestId={dataTestId}
            onFocus={handleFocus}
            onTextChange={setRaw}
            onCommit={commit}
          />
        )}
      </div>
      {browserAnchor && typeof document !== "undefined" && (
        <FormulaBrowser
          catalog={catalog}
          anchor={browserAnchor}
          dataTestId={dataTestId}
          onClose={() => setBrowserAnchor(null)}
          onInsert={(source, caretOffset) =>
            editorRef.current?.insertFormulaSource(source, caretOffset)
          }
        />
      )}
      {bound && numericPreview !== undefined && (
        <div
          className="field__hint formula-unit-input__preview"
          data-testid={dataTestId ? `${dataTestId}-preview` : undefined}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>
            → {formatNumber(fromSI(numericPreview))}
            {symbol ? ` ${symbol}` : ""}
            <span
              style={{ color: "var(--text-3)" }}
              title={FORMULA_SEMANTICS_HELP}
            >
              {" "}
              (resolved once before each solve)
            </span>
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid={dataTestId ? `${dataTestId}-use-resolved` : undefined}
            title="Replace the formula with its currently resolved literal value"
            onClick={useResolved}
          >
            Use resolved value
          </button>
        </div>
      )}
      {bound &&
        preview?.status === "error" &&
        preview.errors.map((message, i) => (
          <div
            key={i}
            className="banner banner--error schedule-editor__alert"
            role="alert"
            data-testid={dataTestId ? `${dataTestId}-error` : undefined}
          >
            {message}
          </div>
        ))}
      {rangeWarning !== null && (
        <div
          className="banner banner--warn schedule-editor__alert"
          role="alert"
          data-testid={dataTestId ? `${dataTestId}-range-warning` : undefined}
        >
          {rangeWarning}
        </div>
      )}
      {candidateError !== null && (
        <div
          className="banner banner--error schedule-editor__alert"
          role="alert"
          data-testid={dataTestId ? `${dataTestId}-parse-error` : undefined}
        >
          {candidateError}
        </div>
      )}
      {focused && !bound && !runtimeSemantics && candidateError === null && (
        <div
          className="field__hint"
          data-testid={dataTestId ? `${dataTestId}-help` : undefined}
        >
          {FORMULA_SCOPE_HELP} {FORMULA_SEMANTICS_HELP}
        </div>
      )}
    </div>
  );
}
