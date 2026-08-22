/**
 * Solid/ambient thermal subsystem.
 *
 * Solid-node temperatures are solved in their own small Newton iteration
 * (`solveThermalSubsystem`), segregated from the fluid unknowns: the fluid
 * side sees the walls through the conductor heat rates, and the wall side
 * sees the fluid through the (frozen) h map and fluid temperatures.  One
 * shared assembly function (`assembleThermalSubsystem`) produces both the
 * residual and its EXACT analytic Jacobian, and the probe hook
 * (`probeThermalSubsystem`) exposes the same assembly to the FD-vs-analytic
 * Jacobian guard tests so probe and production can never drift.
 */
import type { ConductorEntry, SolverContext, StepState } from "./types";
import { heatInputOf } from "./types";
import { solveDense } from "./linalg";
import { FALLBACK_H_FLOOR } from "../correlations";

const STEFAN_BOLTZMANN = 5.670374419e-8;

/**
 * Conductor conductance G [W/K].  `t` is the candidate step's END time [s]
 * (backward Euler): a `{ timeTable }` k reads its constant-for-the-step value
 * k(t) here and has no T-derivative inside the step.  Reading a time table
 * with NO time context (steady solves) throws — validate.ts rejects
 * steady + timeTable configs first; this is the solver-side defense so a
 * time-varying property is never silently evaluated at t = 0.
 */
function getConductance(
  cond: ConductorEntry,
  Tfrom: number,
  Tto: number,
  hMap?: Map<string, number>,
  t?: number,
): number {
  if (cond.type.kind === "conduction") {
    let k: number;
    if (cond.kTimeCurve !== undefined) {
      if (t === undefined) {
        throw new Error(
          `conductor ${cond.id}: k timeTable requires a transient solve time (no steady-state meaning)`,
        );
      }
      k = cond.kTimeCurve.value(t);
    } else {
      // T-dependent k is evaluated at the endpoint mean temperature (the standard
      // mean-property approximation for a 1-D link; exact for constant k).
      k = cond.kCurve
        ? cond.kCurve.value(0.5 * (Tfrom + Tto))
        : (cond.type.k as number);
    }
    return (k * cond.type.area) / cond.type.length;
  }
  if (cond.type.kind === "convection") {
    const h = hMap?.get(cond.id) ?? cond.type.h ?? FALLBACK_H_FLOOR;
    return h * cond.type.area;
  }
  // Radiation has no single linear conductance: the T⁴ law is handled
  // explicitly by both callers (computeConductorHeatRate's early return and
  // the radiation Jacobian branch in assembleThermalSubsystem) before this
  // function is reached — fail loudly if a future caller forgets.
  throw new Error(
    `conductor ${cond.id}: getConductance is undefined for kind "${cond.type.kind}"`,
  );
}

export function computeConductorHeatRate(
  cond: ConductorEntry,
  Tfrom: number,
  Tto: number,
  hMap?: Map<string, number>,
  t?: number,
): number {
  if (cond.type.kind === "radiation") {
    return (
      STEFAN_BOLTZMANN *
      cond.type.emissivity *
      cond.type.area *
      cond.type.viewFactor *
      (Math.pow(Tfrom, 4) - Math.pow(Tto, 4))
    );
  }
  const G = getConductance(cond, Tfrom, Tto, hMap, t);
  return G * (Tfrom - Tto);
}

/** Assemble the solid/ambient thermal-subsystem residual f and its EXACT
 *  analytic Jacobian J = ∂f/∂T at the current solid temperatures (or at
 *  `Tvec`, indexed by solidIndex, without mutating state — the probe path).
 *
 *  Residual f[i] = net heat INTO solid node i (0 at steady state):
 *    - transient storage:  −(m/dt)·(H(T_i) − H(T_i_old))  with
 *      H(T) = ∫ cp dT — the ENTHALPY form, exact for the piecewise-linear
 *      cp curve (no per-step quadrature error, no frozen-cp lag across a
 *      large ΔT step; for constant cp the legacy m·cp·ΔT/dt form is kept
 *      bit-identical).  Jacobian term: −(m/dt)·cp(T_i) — the exact
 *      derivative dH/dT = cp(T_i).
 *      TIME-dependent cp (`{ timeTable }`): the storage term is the
 *      constant-cp form with cp = cp(t_end) evaluated at the candidate
 *      step's END time (backward Euler), frozen across the Newton — exact
 *      per-step Jacobian −(m/dt)·cp(t_end).
 *    - heatInput source:  +Q_i.
 *    - conductors: ∓Q per endpoint.  Conduction with T-dependent k uses
 *      k(Tm), Tm = (Tf+Tt)/2, with exact derivative terms
 *      ∂Q/∂Tf = G + G'(Tm)·(Tf−Tt)/2, ∂Q/∂Tt = −G + G'(Tm)·(Tf−Tt)/2
 *      (G' piecewise-constant from the k table).  TIME-dependent k
 *      (`{ timeTable }`) uses the constant conductance k(t_end)·A/L for the
 *      step — no T-derivative contribution inside the step.  Convection
 *      (fixed h map) is linear; radiation carries the exact
 *      σ·ε·A·F·4T³ derivative.
 */
function assembleThermalSubsystem(
  ctx: SolverContext,
  state: StepState,
  options: { dt?: number; prevState?: StepState; t?: number },
  hMap: Map<string, number> | undefined,
  Tvec?: number[],
): { f: number[]; J: number[][] } {
  const { solidIds, solidIndex, solidNodeMap, conductors, nSolid } = ctx;
  const n = nSolid;
  // Residual f[i] = net heat into solid node i (should be 0 at steady state)
  const f = new Array(n).fill(0);
  // Jacobian J[i][j] = ∂f_i / ∂T_j
  const J: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  const tempOf = (id: string): number => {
    const si = solidIndex.get(id);
    if (si !== undefined) return Tvec ? Tvec[si] : state.solidT.get(id)!;
    // Ambient solid nodes live in solidT (not solidIndex); fluid nodes in nodeT.
    return state.solidT.get(id) ?? state.nodeT.get(id) ?? 300;
  };

  for (let i = 0; i < n; i++) {
    const nodeId = solidIds[i];
    const node = solidNodeMap.get(nodeId)!;
    if (options.dt !== undefined && options.prevState !== undefined) {
      const cpCurve = ctx.solidCpCurves.get(nodeId);
      const cpTimeCurve = ctx.solidCpTimeCurves.get(nodeId);
      if (cpCurve) {
        const m = node.mass ?? 0;
        if (m > 0) {
          const Told = options.prevState.solidT.get(nodeId)!;
          const Tcurr = tempOf(nodeId);
          f[i] -=
            (m / options.dt) *
            (cpCurve.integral(Tcurr) - cpCurve.integral(Told));
          J[i][i] -= (m / options.dt) * cpCurve.value(Tcurr);
        }
      } else if (cpTimeCurve) {
        // Time-varying cp: FROZEN at the candidate step's end time (backward
        // Euler) — the constant-cp storage form with cp = cp(t_end), exact
        // per-step Jacobian −(m/dt)·cp(t_end).  No time context means a
        // steady/steady-probe solve, which validate.ts has already rejected
        // for timeTable — fail loudly rather than silently reading t = 0.
        if (options.t === undefined) {
          throw new Error(
            `solid node ${nodeId}: cp timeTable requires a transient solve time (no steady-state meaning)`,
          );
        }
        const m = node.mass ?? 0;
        if (m > 0) {
          const mc = m * cpTimeCurve.value(options.t);
          const Told = options.prevState.solidT.get(nodeId)!;
          const Tcurr = tempOf(nodeId);
          f[i] -= (mc / options.dt) * (Tcurr - Told);
          J[i][i] -= mc / options.dt;
        }
      } else {
        // Constant-cp legacy path.  The material-property nuisance scale
        // (closureParams.solidCpScale) multiplies the storage term; scale = 1
        // keeps the legacy arithmetic EXACTLY (explicit guard — no rounding).
        const cpScale = ctx.closureParams.solidCpScale;
        const mcBase =
          (node.mass ?? 0) * (typeof node.cp === "number" ? node.cp : 0);
        const mc = cpScale === 1 ? mcBase : mcBase * cpScale;
        if (mc > 0) {
          const Told = options.prevState.solidT.get(nodeId)!;
          const Tcurr = tempOf(nodeId);
          f[i] -= (mc / options.dt) * (Tcurr - Told);
          J[i][i] -= mc / options.dt;
        }
      }
    }
    f[i] += heatInputOf(ctx, node);
  }

  for (const cond of conductors) {
    const Tfrom = tempOf(cond.from);
    const Tto = tempOf(cond.to);

    const Q = computeConductorHeatRate(cond, Tfrom, Tto, hMap, options.t); // positive = from -> to
    const fromSolid = solidIndex.has(cond.from);
    const toSolid = solidIndex.has(cond.to);

    let dQdTfrom = 0;
    let dQdTto = 0;
    if (cond.type.kind === "radiation") {
      const coef =
        4 *
        STEFAN_BOLTZMANN *
        cond.type.emissivity *
        cond.type.area *
        cond.type.viewFactor;
      dQdTfrom = coef * Math.pow(Tfrom, 3);
      dQdTto = -coef * Math.pow(Tto, 3);
    } else {
      const G = getConductance(cond, Tfrom, Tto, hMap, options.t);
      dQdTfrom = G;
      dQdTto = -G;
      if (cond.type.kind === "conduction" && cond.kCurve) {
        // Q = G(Tm)·(Tfrom − Tto), Tm = (Tfrom + Tto)/2  ⇒  both endpoints get
        // +G'(Tm)·(Tfrom − Tto)/2 (G' = dk/dT·A/L from the k-table slope).
        // (A kTimeCurve conductor is intentionally absent here: its k is a
        // step-frozen constant in T, so it contributes NO T-slope term.)
        const dGdTm =
          (cond.kCurve.slope(0.5 * (Tfrom + Tto)) * cond.type.area) /
          cond.type.length;
        const dG = dGdTm * 0.5 * (Tfrom - Tto);
        dQdTfrom += dG;
        dQdTto += dG;
      }
    }

    // Residual: heat INTO the node
    if (fromSolid) {
      const i = solidIndex.get(cond.from)!;
      f[i] -= Q; // heat leaving via Q counted negatively
      J[i][i] += -dQdTfrom;
      if (toSolid) {
        const j = solidIndex.get(cond.to)!;
        J[i][j] += -dQdTto;
      }
    }
    if (toSolid) {
      const j = solidIndex.get(cond.to)!;
      f[j] += Q; // heat entering via Q counted positively
      J[j][j] += dQdTto;
      if (fromSolid) {
        const i = solidIndex.get(cond.from)!;
        J[j][i] += dQdTfrom;
      }
    }
  }
  return { f, J };
}

/** TEST/PROBE HOOK — the thermal-subsystem analogue of probeJacobians:
 *  evaluate the solid-thermal residual f and its exact analytic Jacobian J at
 *  the current state (or at `Toverride`, indexed by solidIndex) WITHOUT
 *  mutating state.  Used by the analytic-vs-FD Jacobian guard for
 *  T-dependent solid properties.  `options.t` is the candidate step's END
 *  time, consulted only by `{ timeTable }` cp/k curves. */
export function probeThermalSubsystem(
  ctx: SolverContext,
  state: StepState,
  options: { dt?: number; prevState?: StepState; t?: number },
  hMap?: Map<string, number>,
  Toverride?: number[],
): { ids: string[]; f: number[]; J: number[][] } {
  const { f, J } = assembleThermalSubsystem(
    ctx,
    state,
    options,
    hMap,
    Toverride,
  );
  return { ids: [...ctx.solidIds], f, J };
}

/** Solve the solid/ambient thermal subsystem with a dedicated Newton iteration.
 *  Conduction and convection are linear; radiation is handled via exact
 *  Jacobian (derivative of σ·ε·A·F·(T⁴_f − T⁴_t)).  `options.t` is the
 *  candidate step's END time (backward Euler) read by `{ timeTable }`
 *  cp/k curves — constant within the iteration, so the exact-Jacobian
 *  structure is unchanged.
 */
export function solveThermalSubsystem(
  ctx: SolverContext,
  state: StepState,
  options: { dt?: number; prevState?: StepState; tol: number; t?: number },
  hMap?: Map<string, number>,
): { converged: boolean; maxDeltaT: number } {
  const { solidIds, nSolid } = ctx;
  if (nSolid === 0) return { converged: true, maxDeltaT: 0 };

  const n = nSolid;
  const maxIter = 100;
  let converged = false;
  let maxDeltaT = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    const { f, J } = assembleThermalSubsystem(ctx, state, options, hMap);

    // Newton step: J * dT = -f
    const dT = solveDense(
      J,
      f.map((v) => -v),
    );

    maxDeltaT = 0;
    for (let i = 0; i < n; i++) {
      const nodeId = solidIds[i];
      const oldT = state.solidT.get(nodeId)!;
      // Limit temperature step to avoid wild Newton overshoot in radiation-dominated cases
      const clampedDT = Math.max(-100, Math.min(100, dT[i]));
      const newT = Math.max(1.0, oldT + clampedDT);
      maxDeltaT = Math.max(maxDeltaT, Math.abs(clampedDT));
      state.solidT.set(nodeId, newT);
    }

    if (maxDeltaT < options.tol * 100) {
      converged = true;
      break;
    }
  }

  return { converged, maxDeltaT };
}
