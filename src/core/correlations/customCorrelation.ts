/**
 * CUSTOM correlation model — user h expression (safe expression language).
 */
import { RealFluid, clampToValidPH } from "../fluids/realFluid";
import {
  compileExpression,
  ExpressionError,
  type CompiledExpression,
  type ExprScope,
} from "../usercode/expression";
import type {
  CorrelationConductor,
  CorrelationCtx,
  CorrelationState,
  ConvectionCorrelation,
} from "./types";
import { FALLBACK_H_FLOOR } from "./types";
import { massFluxAtNode, conductorFluid } from "./massFlux";

/**
 * Every identifier the custom-h scope can expose — exactly the names
 * evaluateCustomCorrelationH puts in `scope` below (fluid-dependent ones only
 * when the fluid model and geometry supply them).  Exported because the UI
 * needs the same list to tell a RUNTIME h equation (evaluated per step from
 * this local scope) from a STATIC parameter binding over the model scope, and
 * to document the scope in the property panel — see ui/convectionModelUi.ts.
 */
export const CUSTOM_H_SCOPE_IDENTIFIERS = [
  "t",
  "Tf",
  "Tw",
  "P",
  "G",
  "D",
  "area",
  "flowArea",
  "rho",
  "mu",
  "k",
  "cp",
  "Pr",
  "Re",
  "quality",
  "param",
  "params",
] as const;

/**
 * Evaluate a 'custom'-model h expression.  NEVER throws into the solver and
 * never returns a non-finite value: a compile/evaluate failure, a missing
 * scope quantity the expression needs, or a non-finite result all come back
 * as the conductor's fallback (literal h when configured, else
 * FALLBACK_H_FLOOR) — the same contract the named models follow for
 * property failures.  (A finite-but-low result is NOT clamped here: the
 * shared floor clamp + under-relaxation in evaluateConvectionH handle it,
 * so custom h is reported and counted exactly like a named model.)
 *
 * Scope (all values SI; fluid-dependent identifiers are present ONLY when
 * the fluid model / state carries them — an expression that reads an absent
 * identifier fails to evaluate and falls back, which validate.ts cannot
 * pre-judge because it deliberately does no static identifier inference):
 *   t        solve time [s] (0 for steady; the step target time at refresh)
 *   Tf       fluid-node bulk temperature [K]         (state, else 300)
 *   Tw       wall (non-fluid endpoint) temperature [K] — when known
 *   P        fluid-node pressure [Pa]                (state, else 1e5)
 *   G        mass flux ½·Σ|ṁ|/flowArea [kg/m²·s]     — when a flow area is known
 *   D        characteristic diameter [m]             — when configured (or
 *            derived from flowArea by circle equivalence)
 *   flowArea flow area [m²]                          — when configured (or
 *            derived from D)
 *   area     conductor heat-transfer area [m²]
 *   rho, mu, k, cp   fluid properties at the node state (k only for
 *            realFluid — legacy models carry no conductivity, exactly the
 *            dittusBoelter limitation)
 *   Pr       cp·mu/k   — when k > 0 is available
 *   Re       G·D/mu    — when G, D and mu > 0 are available
 *   quality  equilibrium quality                     — realFluid two-phase only
 *   param('name') / params.name   correlation.params constants
 *   plus the expression builtins (min/max/sqrt/…/pi).
 */
export function evaluateCustomCorrelationH(
  cond: CorrelationConductor,
  corr: Extract<ConvectionCorrelation, { model: "custom" }>,
  ctx: CorrelationCtx,
  state: CorrelationState,
  fluidNodeId: string,
  t: number | undefined,
): number {
  const fallbackH = cond.type.h ?? FALLBACK_H_FLOOR;

  // Compiled once per solver context (buildSolverContext).  A hand-built
  // CorrelationCtx without the cache compiles on first use and memoizes
  // into the map when one is present — the map is shared by reference from
  // the solver context, so the h-map refresh path never re-parses source.
  let compiled: CompiledExpression | undefined = ctx.customExpressions?.get(
    cond.id,
  );
  if (compiled === undefined) {
    const source = corr.expression;
    if (typeof source !== "string" || source.trim().length === 0)
      return fallbackH;
    try {
      compiled = compileExpression(source);
    } catch {
      return fallbackH; // validate.ts reports parse errors; never throw here
    }
    ctx.customExpressions?.set(cond.id, compiled);
  }

  const P = state.nodeP.get(fluidNodeId) ?? 1e5;
  const Tf = state.nodeT.get(fluidNodeId) ?? 300;
  const scope: ExprScope = { t: t ?? 0, Tf, P, area: cond.type.area };
  const wallNodeId = fluidNodeId === cond.from ? cond.to : cond.from;
  const Tw = state.solidT?.get(wallNodeId);
  if (Tw !== undefined) scope.Tw = Tw;

  // Geometry (both OPTIONAL for custom): derive one from the other by the
  // same circle-equivalence convention the named models use for the
  // flowArea default.
  const D =
    corr.diameter ??
    (corr.flowArea !== undefined
      ? Math.sqrt((4 * corr.flowArea) / Math.PI)
      : undefined);
  const flowArea =
    corr.flowArea ??
    (corr.diameter !== undefined
      ? (Math.PI / 4) * corr.diameter * corr.diameter
      : undefined);
  if (D !== undefined) scope.D = D;
  if (flowArea !== undefined) {
    scope.flowArea = flowArea;
    scope.G = massFluxAtNode(fluidNodeId, ctx.branches, state.mdots) / flowArea;
  }

  // Named constants: param('name') and params.name (own properties only;
  // the evaluator already blocks __proto__/constructor/prototype reads).
  const params = corr.params ?? {};
  scope.params = params;
  scope.param = (name: unknown): number => {
    if (typeof name !== "string") {
      throw new ExpressionError(
        "evaluate",
        "param(...) requires a string-literal name",
      );
    }
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new ExpressionError(
        "evaluate",
        `param('${name}') references unknown param '${name}'`,
      );
    }
    return params[name];
  };

  // Fluid/state properties — same access + fallback policy as the named
  // models (dittusBoelter): node-enthalpy state when carried, else the
  // P,T path; a property failure leaves the fluid-dependent identifiers
  // absent (an expression needing them fails over to the fallback below).
  try {
    let mu: number | undefined;
    let k: number | undefined;
    let cp: number | undefined;
    let rho: number | undefined;
    let quality: number | undefined;
    const cf = conductorFluid(ctx, fluidNodeId);
    if (cf instanceof RealFluid) {
      const fluid = cf;
      const hNode = state.nodeH?.get(fluidNodeId);
      if (hNode !== undefined) {
        const [cP, cH] = clampToValidPH(fluid.fluidName, P, hNode);
        const ph = fluid.statePH(cP, cH);
        mu = ph.mu;
        k = ph.k;
        cp = ph.cp;
        rho = ph.rho;
        quality = ph.quality;
      } else {
        mu = fluid.viscosity(P, Tf);
        cp = fluid.cp(P, Tf);
        rho = fluid.density(P, Tf);
        k = fluid.statePH(P, fluid.enthalpyPT(P, Tf)).k;
      }
    } else {
      // Analytic fluid models carry no thermal conductivity (the documented
      // dittusBoelter limitation) — k (and hence Pr) stay absent.
      mu = cf.viscosity(P, Tf);
      rho = cf.density(P, Tf);
      cp = cf.cp(P, Tf);
    }
    if (mu !== undefined && Number.isFinite(mu)) scope.mu = mu;
    if (k !== undefined && Number.isFinite(k)) scope.k = k;
    if (cp !== undefined && Number.isFinite(cp)) scope.cp = cp;
    if (rho !== undefined && Number.isFinite(rho)) scope.rho = rho;
    if (quality !== undefined && Number.isFinite(quality))
      scope.quality = quality;
    const muV = scope.mu as number | undefined;
    const kV = scope.k as number | undefined;
    const cpV = scope.cp as number | undefined;
    if (muV !== undefined && cpV !== undefined && kV !== undefined && kV > 0) {
      scope.Pr = (cpV * muV) / kV;
    }
    const GV = scope.G as number | undefined;
    const DV = scope.D as number | undefined;
    if (GV !== undefined && DV !== undefined && muV !== undefined && muV > 0) {
      scope.Re = (GV * DV) / muV;
    }
  } catch {
    // Property failure (e.g. CoolProp abort): leave the fluid-dependent
    // identifiers absent; an expression needing them fails over below.
  }

  let h: number;
  try {
    h = compiled.evaluateNumber(scope);
  } catch {
    return fallbackH; // unknown identifier / wrong-typed read / non-numeric result
  }
  return Number.isFinite(h) ? h : fallbackH;
}
