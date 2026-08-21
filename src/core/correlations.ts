/**
 * Convection-correlation models — public entry point.
 *
 * The implementation lives in ./correlations/, split by concern:
 *
 *   correlations/dispatcher.ts       evaluateConvectionH — picks the
 *                                    configured model, applies the shared
 *                                    fallback-floor clamp + under-relaxation.
 *                                    The "how h is computed" file.
 *   correlations/types.ts            ConvectionCorrelation / CorrelationCtx /
 *                                    CorrelationState / shared-state shapes,
 *                                    FALLBACK_H_FLOOR, H_RELAX.
 *   correlations/dittusBoelter.ts    Dittus–Boelter Nu correlation.
 *   correlations/miropolskii.ts      Miropolskii film-boiling correlation
 *                                    (+ the public miropolskiiPipeH helper).
 *   correlations/dhSatBundle.ts      Saturation-property bundle assembly
 *                                    shared by the darrHartwig/ttWf wrappers.
 *   correlations/darrHartwigWrapper.ts  Fluid-bound Darr–Hartwig wrapper +
 *                                    step-level rewet-latch update (the pure
 *                                    algebra lives in ../darrHartwig.ts).
 *   correlations/ttWfWrapper.ts      Fluid-bound TT-WF wrapper + the
 *                                    accepted-step wetted-fraction state
 *                                    lifecycle (pure model in ../ttWf.ts).
 *   correlations/customCorrelation.ts  User h-expression evaluation (the
 *                                    'custom' model) and its documented scope.
 *   correlations/massFlux.ts         massFluxAtNode / conductorFluid — tiny
 *                                    helpers shared by every model path.
 *
 * evaluateConvectionH, updateDarrHartwigLatches and updateTtWfStates are the
 * three functions the solver calls; everything else here is either a
 * building block for those or a narrower public API (miropolskiiPipeH,
 * CUSTOM_H_SCOPE_IDENTIFIERS for the UI).
 */
export type {
  ConvectionCorrelation,
  CorrelationConductor,
  DarrHartwigSharedState,
  TtWfRegimeLabel,
  TtWfStepSnapshot,
  TtWfSharedState,
  CorrelationCtx,
  CorrelationState,
} from "./correlations/types";
export { FALLBACK_H_FLOOR, H_RELAX } from "./correlations/types";

export { miropolskiiPipeH } from "./correlations/miropolskii";

export type { TtWfHeatFluxArgs } from "./correlations/ttWfWrapper";
export { ttWfHeatFlux, updateTtWfStates } from "./correlations/ttWfWrapper";

export type {
  DarrHartwigHeatFluxArgs,
  DarrHartwigHeatFluxOutcome,
} from "./correlations/darrHartwigWrapper";
export {
  darrHartwigHeatFlux,
  updateDarrHartwigLatches,
} from "./correlations/darrHartwigWrapper";

export { CUSTOM_H_SCOPE_IDENTIFIERS } from "./correlations/customCorrelation";

export { evaluateConvectionH } from "./correlations/dispatcher";
