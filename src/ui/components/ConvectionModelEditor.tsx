/**
 * ConvectionModelEditor — "Heat-transfer model" selector + per-model
 * inputs for convection conductors (PropertyPanel).
 *
 * The panel stays operational: selector, fields, units, validation errors
 * and the concise hard-requirement note per model (convectionModelUi.ts).
 * Model theory/equations live in the docs (core/schema.ts correlation
 * docs; core/correlations.ts runtime; core/validate.ts remains the
 * validation authority).
 *
 * Every model switch commits exactly ONE immutable conductor update (via
 * the parent's updateComp), seeded with sensible valid defaults and
 * preserving compatible inputs (see ui/convectionModelUi.ts).
 *
 * "Specified h" is ONE selector entry with ONE h box: a constant and an
 * equation are typed in the same place, and convectionModelUi decides which
 * of the schema's three forms the typed value lands in.  An h equation over
 * the solver's local scope keeps the extra inputs that scope needs
 * (characteristic diameter / flow area for D, G and Re; named constants for
 * param('name')) — they are the same optional geometry the named models use.
 */
import React from "react";
import FormulaUnitInput from "./FormulaUnitInput";
import type { ConvectionModelKey, ConvectionType } from "../convectionModelUi";
import {
  CONVECTION_MODEL_INFO,
  convectionModelOf,
  convectionTypeForModel,
  convectionTypeForSpecifiedH,
  parseParamsText,
  specifiedHOf,
} from "../convectionModelUi";
import { expressionParseError } from "../formulaBinding";
import { CUSTOM_H_SCOPE_IDENTIFIERS, derivedAxialPosition } from "../../core";
import { useStore } from "../store";

/** Under the h box when it holds a constant or a static equation. */
const SPECIFIED_H_HELP =
  "A constant, or an equation for h. An equation over the local flow state " +
  "(Re, Pr, G, D, Tf, Tw, …) is evaluated by the solver as it runs; one over the " +
  "model itself (pipe(…), reg(…), …) resolves once before each solve.";

/** Under the h box when the equation is evaluated by the solver. */
const RUNTIME_H_HELP =
  `Evaluated in SI at every h refresh. Scope: ${CUSTOM_H_SCOPE_IDENTIFIERS.join(", ")} ` +
  "— G, D and Re need the characteristic diameter or flow area below, and a quantity the " +
  "fluid model does not carry (k on the legacy models) falls back to the 5 W/m²·K floor. " +
  "Wrap the equation in max(…) for a floor of your own.";

export interface ConvectionModelEditorProps {
  /** Conductor id — used for formula preview paths and testids. */
  conductorId: string;
  /** Current convection type block. */
  type: ConvectionType;
  /** Commit a whole new type block (one undoable store update). */
  updateComp: (patch: Record<string, unknown>) => void;
  /** Base testid: `${testid}-model`, `-expression`, `-params`, … */
  testid: string;
}

/** Commit-on-blur JSON editor for custom-model params. */
function ParamsField({
  value,
  onCommit,
  testid,
}: {
  value: Record<string, number> | undefined;
  onCommit: (params: Record<string, number> | undefined) => void;
  testid: string;
}) {
  const id = React.useId();
  const asText = value === undefined ? "" : JSON.stringify(value);
  const [raw, setRaw] = React.useState(asText);
  const [focused, setFocused] = React.useState(false);
  // A committed-but-invalid text stays editable: the stored value is NOT
  // replaced until the text parses (same never-clobber rule as schedules).
  const [draftError, setDraftError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!focused) {
      setRaw(asText);
      setDraftError(null);
    }
  }, [asText, focused]);

  const commit = () => {
    setFocused(false);
    const parsed = parseParamsText(raw);
    if (!parsed.ok) {
      setDraftError(parsed.error);
      return;
    }
    setDraftError(null);
    const nextText =
      parsed.params === undefined ? "" : JSON.stringify(parsed.params);
    if (nextText !== asText) onCommit(parsed.params);
  };

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        Parameters{" "}
        <span className="field__unit">
          (JSON object of finite numbers; readable as param('name') /
          params.name)
        </span>
      </label>
      <input
        id={id}
        data-testid={testid}
        className="input"
        type="text"
        value={focused ? raw : asText}
        aria-invalid={draftError !== null || undefined}
        placeholder='{"C": 0.023}'
        onFocus={() => {
          setRaw(asText);
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
      {draftError !== null && (
        <div
          className="banner banner--error schedule-editor__alert"
          role="alert"
          data-testid={`${testid}-error`}
        >
          {draftError}
        </div>
      )}
    </div>
  );
}

export default function ConvectionModelEditor({
  conductorId,
  type,
  updateComp,
  testid,
}: ConvectionModelEditorProps) {
  const modelId = React.useId();
  const model = convectionModelOf(type);
  const info = CONVECTION_MODEL_INFO[model];
  const corr = type.correlation;
  const config = useStore((s) => s.config);
  const specified = model === "specified" ? specifiedHOf(type) : undefined;
  /** h is a solver-evaluated equation: the custom correlation block is live. */
  const hEquation = specified?.kind === "runtime";
  const hEquationSource = hEquation ? specified.expr : undefined;
  const hEquationError =
    hEquationSource === undefined
      ? null
      : expressionParseError(hEquationSource);
  /** Stable value for the h box: the equation source reads as a binding. */
  const hValue = React.useMemo(
    () => (hEquationSource === undefined ? type.h : { expr: hEquationSource }),
    [hEquationSource, type.h],
  );
  /** Correlation geometry applies to the named models and to an h equation. */
  const showGeometry = model !== "specified" || hEquation;
  const derivedZ = React.useMemo(
    () =>
      showGeometry && corr?.axialPosition === undefined
        ? derivedAxialPosition(config, conductorId)
        : undefined,
    [showGeometry, corr?.axialPosition, config, conductorId],
  );

  const selectModel = (next: string) => {
    const key = next as ConvectionModelKey;
    if (key === model) return;
    // One immutable/undoable update with defaults + preserved compatibles.
    updateComp(convectionTypeForModel(key, type));
  };

  /** Patch the correlation block, dropping keys set to undefined. */
  const updateCorr = (patch: Record<string, unknown>) => {
    if (!corr) return;
    const merged: Record<string, unknown> = { ...corr, ...patch };
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key];
    }
    updateComp({ correlation: merged });
  };

  const areaPath = `conductor '${conductorId}'.area`;
  const diameterPath = `conductor '${conductorId}'.correlation.diameter`;
  const flowAreaPath = `conductor '${conductorId}'.correlation.flowArea`;

  return (
    <div className="convection-model-editor" data-testid={testid}>
      <div className="field">
        <label className="field__label" htmlFor={modelId}>
          Heat-transfer model
        </label>
        <select
          id={modelId}
          className="select"
          data-testid={`${testid}-model`}
          value={model}
          onChange={(e) => selectModel(e.target.value)}
        >
          {(Object.keys(CONVECTION_MODEL_INFO) as ConvectionModelKey[]).map(
            (key) => (
              <option key={key} value={key}>
                {CONVECTION_MODEL_INFO[key].label}
              </option>
            ),
          )}
        </select>
      </div>

      {info.warning && (
        <div
          className="banner banner--warn schedule-editor__alert"
          data-testid={`${testid}-warning`}
          role="note"
        >
          {info.warning}
        </div>
      )}

      <FormulaUnitInput
        label="Area"
        quantityKind="area"
        value={type.area}
        step={0.0001}
        path={areaPath}
        dataTestId={`${testid}-area`}
        onChange={(v) => updateComp({ area: v })}
      />

      {specified !== undefined && (
        <>
          <FormulaUnitInput
            label="h"
            quantityKind="heatTransferCoeff"
            value={hValue}
            step={1}
            path={`conductor '${conductorId}'.h`}
            dataTestId={`${testid}-h`}
            semantics={hEquation ? "runtime" : "static"}
            onChange={(v) => updateComp(convectionTypeForSpecifiedH(v, type))}
          />
          <div className="field__hint" data-testid={`${testid}-h-help`}>
            {hEquation ? RUNTIME_H_HELP : SPECIFIED_H_HELP}
          </div>
          {/* A stored equation the solver cannot compile would otherwise fail
              over to the h floor silently; validate.ts reports it too. */}
          {hEquationError !== null && (
            <div
              className="banner banner--error schedule-editor__alert"
              role="alert"
              data-testid={`${testid}-h-equation-error`}
            >
              {hEquationError}
            </div>
          )}
        </>
      )}

      {specified === undefined && (
        <FormulaUnitInput
          label="h (fallback floor)"
          quantityKind="heatTransferCoeff"
          value={type.h}
          step={1}
          path={`conductor '${conductorId}'.h`}
          onChange={(v) => updateComp({ h: v })}
        />
      )}

      {/* Geometry: diameter is REQUIRED for the named models; both diameter
          and flowArea are optional for an h equation (schema.ts). */}
      {showGeometry && (
        <>
          {!hEquation && (
            <FormulaUnitInput
              label="Correlation diameter"
              quantityKind="length"
              value={corr?.diameter}
              step={0.001}
              path={diameterPath}
              dataTestId={`${testid}-diameter`}
              onChange={(v) => updateCorr({ diameter: v })}
            />
          )}
          {hEquation && (
            <>
              <div className="field">
                <label
                  className="field__label"
                  style={{ display: "flex", alignItems: "center", gap: 6 }}
                >
                  <input
                    type="checkbox"
                    data-testid={`${testid}-diameter-toggle`}
                    checked={corr?.diameter !== undefined}
                    onChange={(e) =>
                      updateCorr({
                        diameter: e.target.checked ? 0.05 : undefined,
                      })
                    }
                    style={{ cursor: "pointer" }}
                  />
                  Set characteristic diameter D (exposes D / derived flowArea in
                  scope)
                </label>
              </div>
              {corr?.diameter !== undefined && (
                <FormulaUnitInput
                  label="Correlation diameter"
                  quantityKind="length"
                  value={corr.diameter}
                  step={0.001}
                  path={diameterPath}
                  dataTestId={`${testid}-diameter`}
                  onChange={(v) => updateCorr({ diameter: v })}
                />
              )}
            </>
          )}
          <FormulaUnitInput
            label="Flow area (optional)"
            quantityKind="area"
            value={corr?.flowArea}
            step={0.0001}
            path={flowAreaPath}
            dataTestId={`${testid}-flow-area`}
            onChange={(v) => updateCorr({ flowArea: v })}
          />
          <FormulaUnitInput
            label={
              model === "darrHartwig" || model === "ttWf"
                ? "Axial position z"
                : "Axial position z (optional)"
            }
            quantityKind="length"
            value={corr?.axialPosition}
            step={0.1}
            path={`conductor '${conductorId}'.correlation.axialPosition`}
            dataTestId={`${testid}-axial-position`}
            requirePositive={false}
            onChange={(v) => updateCorr({ axialPosition: v })}
          />
          {derivedZ !== undefined && (
            <div
              className="field__hint"
              data-testid={`${testid}-axial-position-derived`}
            >
              from path, {derivedZ} m
            </div>
          )}
        </>
      )}

      {(model === "darrHartwig" || model === "ttWf") && (
        <FormulaUnitInput
          label="Inlet liquid Reynolds (optional)"
          quantityKind="dimensionless"
          step={1000}
          value={corr?.inletLiquidReynolds}
          path={`conductor '${conductorId}'.correlation.inletLiquidReynolds`}
          onChange={(v) => updateCorr({ inletLiquidReynolds: v })}
          dataTestId={`${testid}-inlet-re`}
        />
      )}

      {model === "ttWf" && (
        <>
          <FormulaUnitInput
            label="Segment length Δz"
            quantityKind="length"
            value={corr?.segmentLength}
            step={0.1}
            path={`conductor '${conductorId}'.correlation.segmentLength`}
            onChange={(v) => updateCorr({ segmentLength: v })}
          />
          <FormulaUnitInput
            label="Front energy factor C_q (optional)"
            quantityKind="dimensionless"
            step={0.05}
            value={corr?.frontEnergyFactor}
            path={`conductor '${conductorId}'.correlation.frontEnergyFactor`}
            onChange={(v) => updateCorr({ frontEnergyFactor: v })}
            dataTestId={`${testid}-front-energy`}
          />
          <FormulaUnitInput
            label="Rewet hysteresis ΔT_h (optional)"
            unitNote="K"
            step={0.1}
            value={corr?.rewetHysteresisOffsetK}
            path={`conductor '${conductorId}'.correlation.rewetHysteresisOffsetK`}
            onChange={(v) => updateCorr({ rewetHysteresisOffsetK: v })}
            dataTestId={`${testid}-rewet-hysteresis`}
          />
          <div className="field">
            <label
              className="field__label"
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <input
                type="checkbox"
                data-testid={`${testid}-fluid-front`}
                checked={corr?.fluidFront === true}
                onChange={(e) =>
                  updateCorr({
                    fluidFront: e.target.checked ? true : undefined,
                  })
                }
                style={{ cursor: "pointer" }}
              />
              Gate the dry side by the transported cryogenic front (fluid-front
              transport, opt-in)
            </label>
          </div>
        </>
      )}

      {hEquation && (
        <ParamsField
          value={corr?.params}
          testid={`${testid}-params`}
          onCommit={(params) => updateCorr({ params })}
        />
      )}
    </div>
  );
}
