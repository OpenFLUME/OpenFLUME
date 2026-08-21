/**
 * Public API surface of the thermal-fluid network core.
 *
 * This is the only file external code (src/ui, tests outside __tests__
 * co-location) should import from — it re-exports the stable types and
 * functions from every module below. Internals not re-exported here
 * (e.g. solver step/context internals, transient/ and validate/ submodule
 * pieces) are implementation details and may change without notice. See
 * each source module's own header comment for what it's responsible for:
 *   fluids/, components/, correlations/  — physics building blocks
 *   schema.ts, config.ts, paramBindings.ts, geometry.ts, topology.ts — network
 *     definition, decoding, parameter resolution, and graph structure
 *   solver.ts, transient.ts, continuation.ts — steady/transient/homotopy solves
 *   validate.ts — semantic validation of a resolved network
 *   ttWf.ts, fluidFront.ts, darrHartwig.ts — quench-front / two-phase models
 *   logicRuntime.ts, controllerRuntime.ts — user logic and PID/register control
 *   solidProperties.ts, closureParams.ts — solid material data and calibratable
 *     correlation constants
 *   usercode/ — sandboxed user-defined components and expressions
 *   diagnostics.ts — opt-in solver instrumentation counters
 */
export type { FluidModel, FluidPhase, PHState, PHStateDual } from "./fluids";
export {
  IncompressibleLiquid,
  IdealGas,
  ExpandableLiquid,
  createFluidModel,
  clampToValidPH,
  clampToValidPT,
} from "./fluids";
export { initRealFluids, realFluidsReady } from "./fluids/coolprop";
export { RealFluid, SUPPORTED_REAL_FLUIDS } from "./fluids/realFluid";
export {
  FLUID_CATALOGUE,
  FLUID_CATALOGUE_COUNT,
  canonicalizeFluidName,
  isCatalogueFluid,
  getFluidCatalogueEntry,
  fluidHasViscosityModel,
  fluidHasConductivityModel,
  CURATED_REAL_FLUIDS,
  isCuratedRealFluid,
} from "./fluids/fluidCatalogue";
export type {
  FluidCatalogueEntry,
  FluidTransportFlag,
  HeosFluidName,
} from "./fluids/fluidCatalogue";
export type { SupportedRealFluid } from "./fluids/realFluid";
export type { BranchComponent } from "./components";
export {
  Pipe,
  Orifice,
  OrificeCompressible,
  CavitatingVenturi,
  FlowResistance,
  Valve,
  CheckValve,
  ReliefValve,
  Pump,
  Bend,
  AreaChange,
  FlowSource,
  Regulator,
  HeatedPipe,
  DpTable,
  CustomResistance,
  UserDefinedComponent,
  interpolateSchedule,
  darcyFrictionFactor,
  darcyFrictionFactorDual,
  RE_LAMINAR,
  RE_TURBULENT,
} from "./components";
export type {
  NetworkConfig,
  SteadyResult,
  TransientResult,
  SolidNode,
  Conductor,
  SolidPropertySpec,
  GravityVector,
  NumberOrExpression,
  ResolvedNetworkConfig,
  PhysicalPosition,
  FluidSpec,
  FluidModelKind,
  HookEvent,
  UserComponentLibraryEntry,
  LogicRule,
  ControllerConfig,
  ControllerSense,
  ControllerOutputTarget,
} from "./schema";
export {
  DEFAULT_GRAVITY,
  STANDARD_GRAVITY_MAGNITUDE,
  FLUID_MODELS,
} from "./schema";
export {
  createFluidAssignment,
  resolvedFluidName,
  resolveFluidSpec,
  eachFluidSpec,
  networkHasNamedFluidAssignment,
  networkUsesRealFluid,
} from "./fluidAssignment";
export type { FluidAssignment, FluidAssignmentMaps } from "./fluidAssignment";
export {
  resolveNetworkParameters,
  previewNetworkParameters,
  isParameterExpression,
} from "./paramBindings";
export type { ParameterResolution } from "./paramBindings";
export {
  ExpressionError,
  parseExpression,
  compileExpression,
  evaluateExpression,
  expressionBuiltinNames,
  UserCodeError,
  defineComponent,
  compileUserComponent,
  compileInlinePressureDrop,
  checkUserCodeSyntax,
} from "./usercode";
export type {
  ExprValue,
  ExprScope,
  ExprNode,
  BinaryOp,
  CompiledExpression,
  UserCodePhase,
  UserComponentParamSpec,
  UserComponentMetadata,
  UserPressureDropArgs,
  UserHeatArgs,
  UserComponentDefinition,
} from "./usercode";
export type {
  ClosureParams,
  ResolvedClosureParams,
  DittusBoelterClosureParams,
  MiropolskiiClosureParams,
  SwameeJainClosureParams,
} from "./closureParams";
export {
  DEFAULT_CLOSURE_PARAMS,
  resolveClosureParams,
  validateClosureParams,
} from "./closureParams";
export { CUSTOM_H_SCOPE_IDENTIFIERS } from "./correlations";
export { validateNetwork } from "./validate";
export {
  withDerivedGeometry,
  derivedAxialPosition,
  physicalPosition,
} from "./geometry";
export {
  decodeNetworkConfig,
  decodeAndValidateNetwork,
  ConfigDecodeError,
  SUPPORTED_CONFIG_VERSION,
} from "./config";
export type { ConfigDecodeErrorCode, DecodedNetwork } from "./config";
export {
  CONDUCTOR_KINDS,
  createTopologyModel,
  classifyEndpoint,
  isFluidNode,
  isThermalNode,
  fluidBranchEndpointError,
  conductorEndpointError,
  compatibleConductorNodeIds,
  compatibleConductorKinds,
  canStartFluidBranch,
  canStartConductor,
} from "./topology";
export type { ConductorKind, TopologyModel, EndpointClass } from "./topology";
export {
  LogicRuntime,
  createLogicRuntime,
  logicResultFields,
} from "./logicRuntime";
export type { LogicStateScope, LogicEventInfo } from "./logicRuntime";
export {
  ControllerRuntime,
  createControllerRuntime,
  controllerResultFields,
} from "./controllerRuntime";
// Public solver entry points.  Step-level/internals (buildSolverContext,
// solveStateStep, probes, latch/fluid-front updates, SolverContext/StepState
// types, component factory, fluid assignment) are not part of the stable API.
export { solveSteady, componentPressureDrop } from "./solver";
export { solveTransient } from "./transient";
export { seedConfigFromResult, solveWithContinuation } from "./continuation";
export type {
  ContinuationOptions,
  ContinuationResult,
  ContinuationHistoryEntry,
} from "./continuation";
export { getSolverDiagnostics, resetSolverDiagnostics } from "./diagnostics";
export type {
  SolverDiagnostics,
  StatePHFallbackTiers,
  TtWfDiagnostics,
} from "./diagnostics";
export {
  evaluateTtWf,
  initTtWfState,
  resolveTtWfParams,
  ttWfLatchUpdate,
  ttWfLiquidAvailability,
  ttWfSmoothMin,
  ttWfWettedFractionUpdate,
  ttWfFrontEnergyPerLength,
  ttWfWettedPerimeter,
  TTWF_DEFAULT_PARAMS,
  TTWF_INITIAL_STATE,
  TTWF_CHI_DRY,
} from "./ttWf";
export type {
  TtWfParams,
  TtWfState,
  TtWfWallContext,
  TtWfEvaluateArgs,
  TtWfResult,
  TtWfOutcome,
  TtWfLimiter,
} from "./ttWf";
export {
  fluidFrontGate,
  advectFluidFrontUpwindBE,
  fluidFrontBoundaryInflux,
  FLUID_FRONT_BOUNDS_TOL,
} from "./fluidFront";
export type {
  FluidFrontSharedState,
  FluidFrontAdvectionInput,
  FluidFrontAdvectionResult,
} from "./fluidFront";
export type { FluidFrontNodeHistory } from "./schema";
export {
  SOLID_MATERIALS,
  PiecewiseLinearProperty,
  resolveSolidProperty,
  resolveSolidTimeProperty,
  sampleExpressionProperty,
  solidPropertyShape,
  isExpressionSpec,
  isTimeTableSpec,
  validateSolidPropertySpec,
  getSolidMaterialTable,
  nistOfhcCopperCpFit,
  nistOfhcCopperKFit,
  OFHC_COPPER_ASSUMED_RRR,
  nistAl6061CpFit,
  nistAl6061KFit,
  nistSs304CpFit,
  nistSs304KFit,
  nistSs316CpFit,
  nistSs316KFit,
  anl304LCpFit,
  anl304LKFit,
  anl316LCpFit,
  anl316LKFit,
  inconel718CpFit,
  inconel718KFit,
  INCONEL718_GAP_CP_K,
  INCONEL718_GAP_K_K,
  grcop84CpFit,
  grcop84KFit,
  GRCOP84_TMIN,
  GRCOP84_TMAX,
  nistPtfeCpFit,
  nistPtfeKFit,
  nistG10CpFit,
  nistG10KNormalFit,
  nistG10KWarpFit,
} from "./solidProperties";
export type { SolidPropertyShape } from "./solidProperties";
