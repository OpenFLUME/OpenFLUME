/**
 * SolidPropertyField — mode-selecting editor for solid property specs
 * (core/schema.ts `SolidPropertySpec = number | { table } | { material }
 * | { expression, tRange } | { timeTable }`), used for solid-node cp and
 * conduction-conductor k in the PropertyPanel.
 *
 * Five explicit modes (selector: Constant | Material | Temperature table |
 * Temperature equation | Time table):
 *
 *  - Constant — the numeric editor, provided by the CALLER via
 *    `renderConstant`.  For conduction k this is FormulaUnitInput, so a
 *    `{ expr }` formula (resolved once at solve entry) is a constant-mode
 *    value, not a temperature equation;
 *  - Material — dropdown over core's SOLID_MATERIALS registry with the
 *    material's provenance, validity temperature range and clamping behaviour;
 *    writes `{ material: key }` (a literal registry key — deliberately not
 *    formula-bindable);
 *  - Temperature table — a ScheduleEditor grid (Temperature [K] × the
 *    property in its unit kind) with add/remove/paste; writes
 *    `{ table: [[T, v], …] }`;
 *  - Temperature equation — a safe-expression editor (`T` in scope) plus the
 *    sampling range tRange [K, K]; writes `{ expression, tRange }`.  Core
 *    samples the expression ONCE over tRange into the canonical
 *    piecewise-linear T curve (core/solidProperties.ts);
 *  - Time table — a ScheduleEditor grid (Time [s] × property); writes
 *    `{ timeTable: [[t, v], …] }`.  Transient only: the value is frozen at
 *    each accepted step's endpoint time (backward Euler) and steady solves
 *    reject time tables (core/validate.ts).
 *
 * Core validation constraints (validateSolidPropertySpec) are surfaced
 * inline with role="alert" for every non-legacy mode.
 *
 * Switching modes is the ONLY path that changes the spec shape, and it is
 * always explicit: it seeds sensible defaults from the current spec (see
 * ui/solidPropertyUi.ts specForMode) and commits as one undoable store
 * update, exactly like every other property edit.
 */
import React from "react";
import type { SolidPropertySpec } from "../../core";
import { SOLID_MATERIALS, validateSolidPropertySpec } from "../../core";
import NumberField from "./NumberField";
import ScheduleEditor, { ScheduleRow as ScheduleRowT } from "./ScheduleEditor";
import {
  SOLID_PROPERTY_INFO,
  materialLabel,
  specForMode,
  specMode,
  specValueAt,
  tableRangeK,
  type SolidPropertyKind,
  type SolidPropertyMode,
} from "../solidPropertyUi";
import { formatSig } from "../format";

type ScheduleRow = ScheduleRowT;

export interface SolidPropertyFieldProps {
  /** Which property is being edited ('cp' for solid nodes, 'k' for conduction). */
  property: SolidPropertyKind;
  /** Current spec (may be undefined for an unset optional cp). */
  spec: SolidPropertySpec | { expr: string } | undefined;
  /** Commit a new spec (undefined allowed only in constant mode, matching
   *  the legacy clear-the-field behaviour for optional cp). */
  onChange: (spec: SolidPropertySpec | { expr: string } | undefined) => void;
  /** Renders the constant-value editor (NumberField, UnitInput, or
   *  FormulaUnitInput).  `{ expr }` formulas are constant-mode values. */
  renderConstant: (
    value: number | { expr: string } | undefined,
    commit: (v: number | { expr: string } | undefined) => void,
  ) => React.ReactNode;
  /** Reference temperature [K] used to seed defaults on a mode switch
   *  (e.g. the solid node's temperature). */
  referenceT?: number;
  /** Owner name for validation messages, e.g. "Solid node s1". */
  owner: string;
  /** Base testid: `${testid}-mode`, `-material`, `-material-info`, `-table`, … */
  testid: string;
}

export default function SolidPropertyField({
  property,
  spec,
  onChange,
  renderConstant,
  referenceT = 300,
  owner,
  testid,
}: SolidPropertyFieldProps) {
  const info = SOLID_PROPERTY_INFO[property];
  const mode = specMode(spec);
  const modeId = React.useId();

  const selectMode = (next: string) => {
    if (next === mode) return;
    onChange(
      specForMode(next as SolidPropertyMode, spec, property, referenceT),
    );
  };

  // Core validation of the CURRENT spec, surfaced inline for the non-legacy
  // modes (constant keeps its historical rely-on-validateNetwork behaviour).
  const errors =
    mode === "constant" ||
    spec === undefined ||
    (typeof spec === "object" && "expr" in spec && !("expression" in spec))
      ? []
      : validateSolidPropertySpec(spec as SolidPropertySpec, property, owner);

  return (
    <div className="solid-property-field" data-testid={testid}>
      <div className="field">
        <label className="field__label" htmlFor={modeId}>
          {info.label} mode
        </label>
        <select
          id={modeId}
          className="select"
          data-testid={`${testid}-mode`}
          aria-label={`${info.label} specification mode`}
          value={mode}
          onChange={(e) => selectMode(e.target.value)}
        >
          <option value="constant">Constant</option>
          <option value="material">Material</option>
          <option value="table">Temperature table</option>
          <option value="expression">Temperature equation</option>
          <option value="timeTable">Time table</option>
        </select>
      </div>

      {mode === "constant" &&
        renderConstant(
          typeof spec === "number" ||
            (spec !== undefined &&
              typeof spec === "object" &&
              "expr" in spec &&
              !("expression" in spec))
            ? spec
            : undefined,
          onChange,
        )}

      {mode === "material" &&
        spec !== undefined &&
        typeof spec === "object" &&
        "material" in spec && (
          <MaterialBody
            property={property}
            material={spec.material}
            onChange={(key) => onChange({ material: key })}
            testid={testid}
          />
        )}

      {mode === "table" &&
        spec !== undefined &&
        typeof spec === "object" &&
        "table" in spec && (
          <>
            <ScheduleEditor
              testid={`${testid}-table`}
              rows={spec.table as ScheduleRow[]}
              onChange={(rows) =>
                onChange({ table: rows as [number, number][] })
              }
              leftKind="temperature"
              rightKind={info.valueKind}
              leftLabel="Temperature"
              rightLabel={info.label}
            />
            <TableHint spec={spec} testid={testid} />
          </>
        )}

      {mode === "expression" &&
        spec !== undefined &&
        typeof spec === "object" &&
        "expression" in spec && (
          <ExpressionBody
            property={property}
            spec={spec}
            referenceT={referenceT}
            onChange={onChange}
            testid={testid}
          />
        )}

      {mode === "timeTable" &&
        spec !== undefined &&
        typeof spec === "object" &&
        "timeTable" in spec && (
          <>
            <ScheduleEditor
              testid={`${testid}-time-table`}
              rows={spec.timeTable as ScheduleRow[]}
              onChange={(rows) =>
                onChange({ timeTable: rows as [number, number][] })
              }
              leftKind="time"
              rightKind={info.valueKind}
              leftLabel="Time"
              rightLabel={info.label}
            />
            <div
              className="field__hint"
              data-testid={`${testid}-time-table-info`}
            >
              Piecewise-linear in time [s], clamped outside the knot range. The
              value is frozen at each accepted step's endpoint time (backward
              Euler). Transient solves only — steady solves reject time tables.
            </div>
          </>
        )}

      {errors.map((message, i) => (
        <div
          key={i}
          className="banner banner--error schedule-editor__alert"
          role="alert"
          data-testid={`${testid}-error`}
        >
          {message}
        </div>
      ))}
    </div>
  );
}

/** Material dropdown + provenance / validity / clamping disclosure. */
function MaterialBody({
  property,
  material,
  onChange,
  testid,
}: {
  property: SolidPropertyKind;
  material: string;
  onChange: (key: string) => void;
  testid: string;
}) {
  const id = React.useId();
  const known = SOLID_MATERIALS[material];
  const [lo, hi] = known ? known.provenance.validityRangeK : [NaN, NaN];
  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={id}>
          Material
        </label>
        <select
          id={id}
          className="select"
          data-testid={`${testid}-material`}
          value={material}
          onChange={(e) => onChange(e.target.value)}
        >
          {SOLID_MATERIALS[material] === undefined && (
            <option value={material} disabled>
              {material} (unknown)
            </option>
          )}
          {Object.keys(SOLID_MATERIALS).map((key) => (
            <option key={key} value={key}>
              {materialLabel(key)}
            </option>
          ))}
        </select>
      </div>
      {known && (
        <div className="field__hint" data-testid={`${testid}-material-info`}>
          <div>{known.provenance.source}.</div>
          <div>
            Valid {lo}–{hi} K — outside this range the value is clamped to the
            nearest end of the range (constant extrapolation).
          </div>
          <div>Stated fit accuracy: {known.provenance.statedFitAccuracy}.</div>
          {property === "k" && known.provenance.rrrAssumed !== undefined && (
            <div>
              k assumes RRR = {known.provenance.rrrAssumed} (k is strongly
              RRR-dependent at low T).
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Table extent + clamping note (the solver clamps to the end knots). */
function TableHint({
  spec,
  testid,
}: {
  spec: { table: Array<[number, number]> };
  testid: string;
}) {
  const range = tableRangeK(spec);
  if (!range) return null;
  const [lo, hi] = range;
  return (
    <div className="field__hint" data-testid={`${testid}-table-info`}>
      {spec.table.length} points, {formatSig(lo, 4)}–{formatSig(hi, 4)} K —
      piecewise-linear in T, clamped to the end values outside this range.
    </div>
  );
}

/** Temperature-equation editor: expression source + tRange [K, K]. */
function ExpressionBody({
  property,
  spec,
  referenceT,
  onChange,
  testid,
}: {
  property: SolidPropertyKind;
  spec: { expression: string; tRange: [number, number] };
  referenceT: number;
  onChange: (spec: SolidPropertySpec | undefined) => void;
  testid: string;
}) {
  const info = SOLID_PROPERTY_INFO[property];
  const id = React.useId();
  const [raw, setRaw] = React.useState(spec.expression);
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (!focused) setRaw(spec.expression);
  }, [spec.expression, focused]);

  const commit = () => {
    setFocused(false);
    if (raw !== spec.expression)
      onChange({ expression: raw, tRange: spec.tRange });
  };

  // Value preview at the reference temperature via the CORE resolver (the
  // same sampling path the solver uses); shape/sampling errors are surfaced
  // by the parent through validateSolidPropertySpec.
  const preview = specValueAt(spec, property, referenceT);

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {info.label}(T) expression{" "}
          <span className="field__unit">({info.siUnit}, T in K)</span>
        </label>
        <input
          id={id}
          data-testid={`${testid}-expression`}
          className="input"
          type="text"
          value={focused ? raw : spec.expression}
          placeholder={
            property === "cp" ? "385 + 0.1 * (T - 300)" : "400 * (T / 300)^0.5"
          }
          onFocus={() => {
            setRaw(spec.expression);
            setFocused(true);
          }}
          onChange={(e) => setRaw(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <div className="field__hint">
          Scope: T [K] and the expression builtins
          (min/max/abs/sqrt/exp/log/sin/cos/tanh/clamp/smoothstep, pi). Sampled
          once over the range below into a piecewise-linear curve (exact solver
          integration thereafter).
        </div>
      </div>
      <NumberField
        label="Range min"
        unitNote="K"
        step={1}
        value={spec.tRange[0]}
        dataTestId={`${testid}-trange-min`}
        onChange={(v) => {
          if (v !== undefined)
            onChange({
              expression: spec.expression,
              tRange: [v, spec.tRange[1]],
            });
        }}
      />
      <NumberField
        label="Range max"
        unitNote="K"
        step={1}
        value={spec.tRange[1]}
        dataTestId={`${testid}-trange-max`}
        onChange={(v) => {
          if (v !== undefined)
            onChange({
              expression: spec.expression,
              tRange: [spec.tRange[0], v],
            });
        }}
      />
      {preview !== undefined && (
        <div
          className="field__hint"
          data-testid={`${testid}-expression-preview`}
        >
          → {info.label}({formatSig(referenceT, 4)} K) ≈ {formatSig(preview, 4)}{" "}
          {info.siUnit}
        </div>
      )}
    </>
  );
}
