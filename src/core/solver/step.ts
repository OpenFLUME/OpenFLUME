/**
 * The step solver: converge ONE state (a steady state, or one implicit
 * transient step of size dt) with a nested iteration:
 *
 *   solveStateStep            — retry cascade for hard transient real-fluid
 *     └ solveStateStepAttempt — one complete solve attempt:
 *         outer Picard loop   — couples the Newton unknowns to everything
 *           │                   solved segregatedly (enthalpy/temperature
 *           │                   updates, species transport, correlation
 *           │                   h-map refresh, solid-wall Newton)
 *           └ inner Newton    — solves R(x) = 0 for x = [P, ṁ (, h)] using
 *                               the kernel's residual/Jacobians, globalized
 *                               by a trust-region dogleg or line search,
 *                               with optional pseudo-transient continuation
 *                               (PTC) for stiff steady real-fluid cases.
 *
 * Which unknowns the inner Newton owns depends on the mode:
 *   - real-fluid transient ("extended system"): [P, ṁ, h] simultaneously;
 *     the outer loop only syncs derived properties and the walls.
 *   - steady kineticEnergy ("coupled h-system", any EOS class): [P, ṁ, h]
 *     simultaneously with stagnation-enthalpy energy rows; the outer loop
 *     only syncs derived properties and the walls.
 *   - real-fluid steady (segregated): [P, ṁ] in Newton; h is updated by the
 *     outer loop from the nodal energy balance.
 *   - ideal gas / incompressible ("legacy"): [P, ṁ] in Newton; T is updated
 *     by the outer loop from the nodal energy balance.
 *
 * Convergence certification, stall/hopeless-step detection and their
 * calibration are documented inline and in docs/solver-convergence.md.
 */
import type { SolverContext, StepState } from "./types";
import { heatInputOf, cloneStepState, copyStepStateInto } from "./types";
import { makeKernel, useCoupledHMode } from "./kernel";
import type { NewtonKernelEnv } from "./kernel";
import { createUniformDofMap } from "./dofMap";
import { computeConductorHMap } from "./conductorH";
import { solveThermalSubsystem } from "./thermal";
import {
  safeStatePH,
  safeInternalEnergyPH,
  clampToValidPHFor,
} from "./safeProps";
import { solveDense, norm2, dot, matVec, matVecTrans } from "./linalg";
import { RealFluid, clampToValidPH, getFluidLimits } from "../fluids/realFluid";
import { IdealGas } from "../fluids";
import { integrateBDF1 } from "../stiffOde";
import { makeChemistryRHS } from "../chemistry";
import { FALLBACK_H_FLOOR } from "../correlations";

/**
 * Settle bar for the reacting-junction product-gas property lag: an outer
 * iterate may certify only when the largest relative change any junction's
 * lag update applied to its product fluid's (R, γ, μ, cp) this iteration is
 * below this.  The gas properties are weak functions of (Pc, O/F) — the
 * lag's loop gain is ≪ 1 — so this settles alongside (not after) the state
 * itself; the bar exists so a certified result is never reported against
 * properties that materially moved after its residual was measured.
 */
const JUNCTION_PARAM_SETTLE_REL = 1e-6;

export interface SolveStepOptions {
  dt?: number;
  t?: number;
  tol: number;
  maxIterations: number;
  relaxation: number;
  prevState?: StepState;
  maxOuter?: number;
  onProgress?: (p: { iteration: number; residual: number }) => void;
  shouldAbort?: () => boolean;
  steadySolver?: "ptc" | "direct";
  globalization?: "trustRegion" | "lineSearch";
  jacobian?: "hybrid" | "fd";
  certifyAfterCoupling?: boolean;
}

export interface SolveStepResult {
  state: StepState;
  converged: boolean;
  iterations: number;
  residual: number;
  residualScaled?: number;
  aborted?: boolean;
  ptcDeltaTau?: number | number[];
  ptcShrinks?: number;
}

export function solveStateStep(
  ctx: SolverContext,
  state: StepState,
  options: SolveStepOptions,
): SolveStepResult {
  // Retry cascade for hard transient real-fluid steps.  The extended-system
  // Newton can stall on dome-edge steps (flashing/cavitating nodes) under
  // one globalization yet converge cleanly under another — empirically the
  // failing direction is not predictable a priori (line search wins on some
  // steps, trust region on others, relaxation 1.0 on yet others).  Each
  // tier is a complete Newton solve from the same entry state; the
  // first tier to meet the convergence bar wins.  If NO tier converges, the
  // best-residual attempt is returned with converged = false (the
  // signal introduced for the chilldown parked-state bug).  Only transient
  // real-fluid extended-system steps cascade; steady and legacy paths keep
  // their single-attempt behaviour.
  const cascadeEligible =
    ctx.isRealFluid && options.dt !== undefined && !options.steadySolver;
  if (!cascadeEligible) {
    return solveStateStepAttempt(ctx, state, options);
  }

  const tiers: Array<Pick<SolveStepOptions, "globalization" | "relaxation">> = [
    // Tier 0: exactly as configured.
    { globalization: options.globalization, relaxation: options.relaxation },
    // Tier 1: undamped line search.
    { globalization: "lineSearch", relaxation: 1.0 },
    // Tier 2: trust region at the configured relaxation.
    { globalization: "trustRegion", relaxation: options.relaxation },
  ];
  // Deduplicate tiers identical to an earlier one.
  const seen = new Set<string>();
  const uniqueTiers = tiers.filter((t) => {
    const key = `${t.globalization ?? "default"}@${t.relaxation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const entry = cloneStepState(state);
  let best: SolveStepResult | undefined;
  let bestState: StepState | undefined;
  // Adaptive tier ordering: hard dome-edge steps cluster within a run, and
  // the step-control that converged the previous hard step is likely to
  // converge the next one.  Try it first; on success, keep it first.  On
  // failure, the full tier set is still attempted (order is the only thing
  // that changes — the candidate solvers are identical).
  const lastGoodTier = ctx.lastGoodCascadeTier ?? 0;
  const tierOrder = uniqueTiers.map((_, i) => i);
  tierOrder.splice(tierOrder.indexOf(lastGoodTier), 1);
  tierOrder.unshift(lastGoodTier);
  for (const tierIdx of tierOrder) {
    const tier = uniqueTiers[tierIdx];
    copyStepStateInto(state, entry);
    // Retry tiers run with a capped budget: a step that converges under a
    // different step-control does so quickly (observed ~20–40 inner
    // iterations, < 5 outer iterations), while a hopeless step burns the
    // full configured budget per tier (the emergent-venturi no-root case
    // costs ~10–30 s per uncapped tier).
    const budgeted =
      tier === uniqueTiers[0]
        ? options
        : {
            ...options,
            maxIterations: Math.min(options.maxIterations, 35),
            maxOuter: Math.min(options.maxOuter ?? 1000, 6),
          };
    const res = solveStateStepAttempt(ctx, state, { ...budgeted, ...tier });
    if (res.converged) {
      ctx.lastGoodCascadeTier = tierIdx;
      return res;
    }
    if (options.shouldAbort && options.shouldAbort()) {
      return { ...res, aborted: true };
    }
    if (best === undefined || res.residual < best.residual) {
      best = res;
      bestState = cloneStepState(state);
    }
  }
  // No tier converged: restore the best attempt's state and return it with
  // converged = false.
  copyStepStateInto(state, bestState!);
  return best!;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers shared by the outer Picard loop of one attempt
// ──────────────────────────────────────────────────────────────────────────

const rfOf = (ctx: SolverContext, id: string) =>
  ctx.fluidAssignment.node(id) as RealFluid;

/** True if any internal node currently sits inside the two-phase dome.
 *  Governs the h-update relaxation and the outer convergence tolerance. */
function anyTwoPhaseNode(ctx: SolverContext, state: StepState): boolean {
  for (const id of ctx.internalIds) {
    const fluid = ctx.fluidAssignment.node(id);
    if (!(fluid instanceof RealFluid)) continue; // analytic: never two-phase
    const h = state.nodeH!.get(id)!;
    const P = state.nodeP.get(id)!;
    const ph = safeStatePH(fluid, P, h, `phase check`);
    if (ph.quality !== undefined && ph.quality > 0 && ph.quality < 1) {
      return true;
    }
  }
  return false;
}

/** Extended system: h was solved by the inner Newton — publish it and sync
 *  the derived properties.  Returns |Δh| for the outer settling test. */
function syncExtendedNode(
  ctx: SolverContext,
  state: StepState,
  nodeId: string,
  Pcurr: number,
  hcurr: number,
): number {
  const deltaH = Math.abs(hcurr - state.nodeH!.get(nodeId)!);
  state.nodeH!.set(nodeId, hcurr);
  const phNew = safeStatePH(
    rfOf(ctx, nodeId),
    Pcurr,
    hcurr,
    `node ${nodeId} post-update`,
  );
  state.nodeT.set(nodeId, phNew.T);
  state.nodeRho.set(nodeId, phNew.rho);
  state.nodeMu.set(nodeId, phNew.mu);
  state.nodeQuality!.set(nodeId, phNew.quality);
  state.nodePhase!.set(nodeId, phNew.phase);
  return deltaH;
}

/** Segregated real-fluid outer h-update for one internal node: solve the
 *  nodal energy balance for h with P and ṁ frozen at the inner Newton's
 *  values (transient: implicit internal-energy balance via bracketing +
 *  bisection; steady: explicit enthalpy balance), then apply it with
 *  under-relaxation hRelax.  Returns the applied |Δh| for the outer
 *  settling test (0 when the steady balance has no outflow to solve). */
function updateSegregatedRealFluidNode(
  ctx: SolverContext,
  state: StepState,
  X: number[],
  hMap: Map<string, number>,
  nodeId: string,
  Pcurr: number,
  hRelax: number,
  dt: number | undefined,
  prevState: StepState | undefined,
): number {
  const { nodeMap, branches, nInt } = ctx;
  const node = nodeMap.get(nodeId)!;
  const nBranch = ctx.nBranch;
  const hcurr = state.nodeH!.get(nodeId)!;
  const phCurr = safeStatePH(
    rfOf(ctx, nodeId),
    Pcurr,
    hcurr,
    `node ${nodeId} energy loop`,
  );
  const Tcurr = phCurr.T;

  // Convection heat rate (W) into the fluid node
  let Qconv = 0;
  for (const cond of ctx.conductors) {
    if (cond.type.kind !== "convection") continue;
    if (cond.from !== nodeId && cond.to !== nodeId) continue;
    const otherId = cond.from === nodeId ? cond.to : cond.from;
    const hEff = hMap.get(cond.id) ?? cond.type.h ?? FALLBACK_H_FLOOR;
    const G = hEff * cond.type.area;
    const T_other =
      state.solidT.get(otherId) ?? state.nodeT.get(otherId) ?? 300;
    Qconv += G * (T_other - Tcurr);
  }

  // Branch enthalpy flows
  let hSum = 0;
  let sumOut = 0;
  for (let j = 0; j < nBranch; j++) {
    const b = branches[j];
    const mdot = X[nInt + j];
    if (b.to === nodeId && mdot > 0) {
      const hUp = state.nodeH!.get(b.from)!;
      hSum += mdot * hUp;
    } else if (b.from === nodeId && mdot < 0) {
      const hUp = state.nodeH!.get(b.to)!;
      hSum += -mdot * hUp;
    } else if (b.from === nodeId && mdot > 0) {
      sumOut += mdot;
    } else if (b.to === nodeId && mdot < 0) {
      sumOut += -mdot;
    }
  }

  // HeatedPipe branch heat
  for (let j = 0; j < nBranch; j++) {
    const b = branches[j];
    const mdot = X[nInt + j];
    if (b.component.getBranchHeat) {
      const dnNode = mdot >= 0 ? b.to : b.from;
      if (dnNode === nodeId) {
        const upNode = mdot >= 0 ? b.from : b.to;
        const Pup = state.nodeP.get(upNode)!;
        const hUp = state.nodeH!.get(upNode)!;
        const phUp = safeStatePH(
          rfOf(ctx, nodeId),
          Pup,
          hUp,
          `node ${nodeId} branch heat`,
        );
        hSum += b.component.getBranchHeat(
          mdot,
          phUp.T,
          phUp.cp ?? 0,
          ctx.fluidAssignment.branch(b.id),
          Pup,
          hUp,
        );
      }
    }
  }

  const Q = heatInputOf(ctx, node);

  if (dt !== undefined) {
    // Transient: implicit solve for h from internal-energy balance
    const dtLocal = dt;
    const V_total = node.volume ?? 0;
    const rhoCurr = phCurr.rho;
    const mCurr = rhoCurr * V_total;
    const rhoPrev = prevState ? prevState.nodeRho.get(nodeId)! : rhoCurr;
    const mPrev = rhoPrev * V_total;

    let uPrev = 0;
    if (prevState) {
      const Pprev = prevState.nodeP.get(nodeId)!;
      const hPrevVal = prevState.nodeH!.get(nodeId)!;
      uPrev = safeInternalEnergyPH(
        rfOf(ctx, nodeId),
        Pprev,
        hPrevVal,
        `node ${nodeId} prev u`,
      );
    } else {
      uPrev = safeInternalEnergyPH(
        rfOf(ctx, nodeId),
        Pcurr,
        hcurr,
        `node ${nodeId} curr u`,
      );
    }

    const RHS = mPrev * uPrev + dt * (hSum + Q + Qconv);

    // Solve m(h)*u(h) + dt * sumOut * h = RHS with a hybrid fallback+
    // bisection.  The Picard loop is unstable in the dome (spectral
    // radius >> 1), so we bracket the root and do a small number of
    // bisection steps starting from a good initial guess.
    const limits = getFluidLimits(rfOf(ctx, nodeId).fluidName);
    let hNew = hcurr;
    function energyResidual(hTest: number): number {
      const ph = safeStatePH(
        rfOf(ctx, nodeId),
        Pcurr,
        hTest,
        `node ${nodeId} hybrid`,
      );
      const mTest = ph.rho * V_total;
      const uTest = safeInternalEnergyPH(
        rfOf(ctx, nodeId),
        Pcurr,
        hTest,
        `node ${nodeId} hybrid u`,
      );
      // For nodes with no inflow, the outflow must satisfy the mass balance:
      //   sumOut = (mPrev - mTest) / dt.
      // Using the inner-loop mdot would make the energy equation inconsistent
      // when density collapses across the dome.  We keep the inflow fixed
      // (from the inner loop) and adjust only the net outflow side.
      const sumOutTest = Math.max(0, (mPrev - mTest) / dtLocal);
      return mTest * uTest + dtLocal * sumOutTest * hTest - RHS;
    }
    const Fcurr = energyResidual(hcurr);
    if (Math.abs(Fcurr) < 1e-12) {
      hNew = hcurr;
    } else {
      // Initial guess from linearised implicit solve (du/dh ≈ 1)
      const sumOutGuess = Math.max(0, (mPrev - mCurr) / dt);
      const hGuess = RHS / (mCurr + dt * sumOutGuess);
      let hLow = Math.min(hcurr, hGuess);
      let hHigh = Math.max(hcurr, hGuess);
      let FLow = energyResidual(hLow);
      let FHigh = energyResidual(hHigh);
      // If signs are the same, expand outward geometrically on both
      // sides so we do not miss a root that lies on the side we did
      // not expand (e.g. boiling pot where F < 0 everywhere above the
      // true root and the root is below hcurr).
      for (let expand = 0; expand < 12; expand++) {
        if (FLow * FHigh <= 0) break;
        hLow = Math.max(limits.hmin, hLow - Math.abs(hLow) * 0.5 - 1000);
        FLow = energyResidual(hLow);
        if (FLow * FHigh <= 0) break;
        hHigh = Math.min(limits.hmax, hHigh + Math.abs(hHigh) * 0.5 + 1000);
        FHigh = energyResidual(hHigh);
      }
      if (FLow * FHigh <= 0) {
        for (let bisect = 0; bisect < 15; bisect++) {
          const hMid = (hLow + hHigh) / 2;
          const FMid = energyResidual(hMid);
          if (Math.abs(FMid) < 1e-6 * Math.max(1, Math.abs(RHS))) {
            hNew = hMid;
            break;
          }
          if (FMid * FLow <= 0) {
            hHigh = hMid;
            FHigh = FMid;
          } else {
            hLow = hMid;
            FLow = FMid;
          }
          if (bisect === 14) {
            hNew = hMid;
          }
        }
      } else {
        // Fallback: pick the endpoint with smaller |F|
        hNew = Math.abs(FLow) < Math.abs(FHigh) ? hLow : hHigh;
      }
    }

    let hRelaxed = hcurr + hRelax * (hNew - hcurr);
    const [, clampedH] = clampToValidPH(
      rfOf(ctx, nodeId).fluidName,
      Pcurr,
      hRelaxed,
    );
    hRelaxed = clampedH;
    const deltaH = Math.abs(hRelaxed - hcurr);
    state.nodeH!.set(nodeId, hRelaxed);
    const phNew = safeStatePH(
      rfOf(ctx, nodeId),
      Pcurr,
      hRelaxed,
      `node ${nodeId} post-update`,
    );
    state.nodeT.set(nodeId, phNew.T);
    state.nodeRho.set(nodeId, phNew.rho);
    state.nodeMu.set(nodeId, phNew.mu);
    state.nodeQuality!.set(nodeId, phNew.quality);
    state.nodePhase!.set(nodeId, phNew.phase);
    return deltaH;
  }

  // Steady: explicit enthalpy balance
  if (sumOut > 1e-12) {
    const hTarget = (hSum + Q + Qconv) / sumOut;
    let hNew = hcurr + hRelax * (hTarget - hcurr);
    const [, clampedH] = clampToValidPH(
      rfOf(ctx, nodeId).fluidName,
      Pcurr,
      hNew,
    );
    hNew = clampedH;
    const deltaH = Math.abs(hNew - hcurr);
    state.nodeH!.set(nodeId, hNew);
    const phNew = safeStatePH(
      rfOf(ctx, nodeId),
      Pcurr,
      hNew,
      `node ${nodeId} steady update`,
    );
    state.nodeT.set(nodeId, phNew.T);
    state.nodeRho.set(nodeId, phNew.rho);
    state.nodeMu.set(nodeId, phNew.mu);
    state.nodeQuality!.set(nodeId, phNew.quality);
    state.nodePhase!.set(nodeId, phNew.phase);
    return deltaH;
  }
  return 0;
}

/** Legacy (ideal-gas / incompressible / species-mixture) outer T-update for
 *  one internal node: solve the nodal energy balance for T with P and ṁ
 *  frozen at the inner Newton's values (transient: linearised implicit
 *  internal-energy balance; steady: explicit enthalpy balance).  Returns
 *  the applied |ΔT| against `oldTVal` (the node's T at the start of this
 *  outer iteration), or 0 when the balance is degenerate.
 *  Bit-identical to the pre-split arithmetic when no species. */
function updateLegacyNode(
  ctx: SolverContext,
  state: StepState,
  X: number[],
  hMap: Map<string, number>,
  nodeId: string,
  Pcurr: number,
  TnStart: number,
  oldTVal: number,
  dt: number | undefined,
  prevState: StepState | undefined,
  /** Per-node adaptive T-Picard damping state (settings.kineticEnergy
   *  steady solves only) — persists across the outer iterations of one
   *  solve attempt. */
  tPicardDamp?: Map<string, { lastDelta: number; relax: number }>,
): number {
  const { nodeMap, branches, nInt } = ctx;
  const node = nodeMap.get(nodeId)!;
  const nBranch = ctx.nBranch;
  const fluidOf = (id: string) => ctx.fluidAssignment.node(id);
  const Tcurr = state.nodeT.get(nodeId)!;
  // settings.kineticEnergy: specific kinetic energy V²/2 carried by branch j
  // at a node's state, with V = ṁ/(ρA) and the branch's own flow area —
  // stagnation-enthalpy transport for the quasi-1-D compressible
  // formulation.  ρ at the upstream endpoint comes from the current state
  // (Picard-lagged, exact at convergence); ρ at this node uses rhoCurr
  // computed below at the inner Newton's fresh pressure.
  const kineticEnergyAt = (
    branchIdx: number,
    end: "from" | "to",
    mdot: number,
    rho: number,
  ): number => {
    if (!ctx.kineticEnergy) return 0;
    const comp = branches[branchIdx].component;
    const A = end === "to" ? (comp.areaOut ?? comp.area) : comp.area;
    if (A === undefined || !(A > 0) || !(rho > 0)) return 0;
    const v = mdot / (rho * A);
    return 0.5 * v * v;
  };
  let cp: number;
  let rhoCurr: number;
  if (ctx.hasSpecies && ctx.mixtureFluid && state.nodeY) {
    const Y = state.nodeY.get(nodeId)!;
    cp = ctx.mixtureFluid.cpMix(Pcurr, Tcurr, Y);
    rhoCurr = ctx.mixtureFluid.densityMix(Pcurr, Tcurr, Y);
  } else {
    cp = fluidOf(nodeId).cp(Pcurr, Tcurr);
    rhoCurr = fluidOf(nodeId).density(Pcurr, Tcurr);
  }

  let convCoeff = 0;
  let convRhs = 0;
  for (const cond of ctx.conductors) {
    if (cond.type.kind !== "convection") continue;
    if (cond.from !== nodeId && cond.to !== nodeId) continue;
    const otherId = cond.from === nodeId ? cond.to : cond.from;
    const hEff = hMap.get(cond.id) ?? cond.type.h ?? FALLBACK_H_FLOOR;
    const G = hEff * cond.type.area;
    const T_other =
      state.solidT.get(otherId) ?? state.nodeT.get(otherId) ?? 300;
    convCoeff += G;
    convRhs += G * T_other;
  }

  if (dt !== undefined) {
    const V_total = node.volume ?? 0;
    let V = V_total;
    const gc = node.gasCushion;
    let mCurr = rhoCurr * V;
    let mPrev = rhoCurr * V;
    if (gc && prevState) {
      const P0 = node.pressure ?? Pcurr;
      const n = gc.polytropicIndex;
      const Vg0 = gc.initialGasVolume;
      const C = P0 * Math.pow(Vg0, n);
      const Vg_curr = Math.pow(C / Pcurr, 1 / n);
      const Vg_prev = Math.pow(C / prevState.nodeP.get(nodeId)!, 1 / n);
      V = V_total - Vg_curr;
      mCurr = rhoCurr * V;
      mPrev = prevState.nodeRho.get(nodeId)! * (V_total - Vg_prev);
    } else {
      const rhoPrev = prevState ? prevState.nodeRho.get(nodeId)! : rhoCurr;
      mPrev = rhoPrev * V;
    }
    const Tn = TnStart;
    const cpNode = fluidOf(nodeId).cp(Pcurr, Tcurr);
    const cv = fluidOf(nodeId).cv(Pcurr, Tcurr);
    const coeffStorage = (mCurr * cv) / dt;
    let coeffOut = 0;
    let outflowH = 0;
    let rhs =
      (mPrev / dt) * fluidOf(nodeId).internalEnergy(Pcurr, Tn) +
      heatInputOf(ctx, node);
    for (let j = 0; j < nBranch; j++) {
      const b = branches[j];
      const mdot = X[nInt + j];
      if (b.to === nodeId && mdot > 0) {
        const Tup = state.nodeT.get(b.from)!;
        rhs += mdot * fluidOf(b.from).enthalpy(state.nodeP.get(b.from)!, Tup);
        rhs +=
          mdot * kineticEnergyAt(j, "from", mdot, state.nodeRho.get(b.from)!);
      } else if (b.from === nodeId && mdot < 0) {
        const Tup = state.nodeT.get(b.to)!;
        rhs += -mdot * fluidOf(b.to).enthalpy(state.nodeP.get(b.to)!, Tup);
        rhs += -mdot * kineticEnergyAt(j, "to", mdot, state.nodeRho.get(b.to)!);
      } else if (b.from === nodeId && mdot > 0) {
        coeffOut += mdot * cpNode;
        outflowH += mdot * fluidOf(nodeId).enthalpy(Pcurr, Tcurr);
        outflowH += mdot * kineticEnergyAt(j, "from", mdot, rhoCurr);
      } else if (b.to === nodeId && mdot < 0) {
        coeffOut += -mdot * cpNode;
        outflowH += -mdot * fluidOf(nodeId).enthalpy(Pcurr, Tcurr);
        outflowH += -mdot * kineticEnergyAt(j, "to", mdot, rhoCurr);
      }
    }
    for (let j = 0; j < nBranch; j++) {
      const b = branches[j];
      const mdot = X[nInt + j];
      if (b.component.getBranchHeat) {
        const dnNode = mdot >= 0 ? b.to : b.from;
        if (dnNode === nodeId) {
          const upNode = mdot >= 0 ? b.from : b.to;
          // Non-real path: still hand the branch fluid and the
          // available upstream pressure/state to the heat closure
          // (user components need them; h is real-fluid-only).
          const branchFluid = ctx.fluidAssignment.branch(b.id);
          const Tup = state.nodeT.get(upNode)!;
          const Pup = state.nodeP.get(upNode)!;
          const cpUp = branchFluid.cp(Pup, Tup);
          rhs += b.component.getBranchHeat(mdot, Tup, cpUp, branchFluid, Pup);
        }
      }
    }
    const denom = coeffStorage + coeffOut + convCoeff;
    if (denom > 1e-12) {
      const u_k = fluidOf(nodeId).internalEnergy(Pcurr, Tcurr);
      const rhs_adj =
        rhs -
        (mCurr / dt) * u_k -
        outflowH +
        (mCurr / dt) * cv * Tcurr +
        coeffOut * Tcurr;
      const newT = (rhs_adj + convRhs) / denom;
      state.nodeT.set(nodeId, newT);
      return Math.abs(newT - oldTVal);
    }
    return 0;
  }

  let sumOut = 0;
  let hSum = 0;
  // Kinetic energy leaving with the outflows, ṁ·V²/2 per branch at THIS
  // node's state — subtracted from the enthalpy balance so the solved h is
  // the STATIC enthalpy while ṁ·(h + V²/2) is what each branch conserves.
  let keOut = 0;
  for (let j = 0; j < nBranch; j++) {
    const b = branches[j];
    const mdot = X[nInt + j];
    if (b.to === nodeId && mdot > 0) {
      const Tup = state.nodeT.get(b.from)!;
      hSum += mdot * fluidOf(b.from).enthalpy(state.nodeP.get(b.from)!, Tup);
      hSum +=
        mdot * kineticEnergyAt(j, "from", mdot, state.nodeRho.get(b.from)!);
    } else if (b.from === nodeId && mdot < 0) {
      const Tup = state.nodeT.get(b.to)!;
      hSum += -mdot * fluidOf(b.to).enthalpy(state.nodeP.get(b.to)!, Tup);
      hSum += -mdot * kineticEnergyAt(j, "to", mdot, state.nodeRho.get(b.to)!);
    } else if (b.from === nodeId && mdot > 0) {
      sumOut += mdot;
      keOut += mdot * kineticEnergyAt(j, "from", mdot, rhoCurr);
    } else if (b.to === nodeId && mdot < 0) {
      sumOut += -mdot;
      keOut += -mdot * kineticEnergyAt(j, "to", mdot, rhoCurr);
    }
  }
  for (let j = 0; j < nBranch; j++) {
    const b = branches[j];
    const mdot = X[nInt + j];
    if (b.component.getBranchHeat) {
      const dnNode = mdot >= 0 ? b.to : b.from;
      if (dnNode === nodeId) {
        const upNode = mdot >= 0 ? b.from : b.to;
        // Non-real path: still hand the branch fluid and the
        // available upstream pressure/state to the heat closure
        // (user components need them; h is real-fluid-only).
        const branchFluid = ctx.fluidAssignment.branch(b.id);
        const Tup = state.nodeT.get(upNode)!;
        const Pup = state.nodeP.get(upNode)!;
        const cpUp = branchFluid.cp(Pup, Tup);
        hSum += b.component.getBranchHeat(mdot, Tup, cpUp, branchFluid, Pup);
      }
    }
  }
  const Q = heatInputOf(ctx, node);
  const denom = sumOut * cp + convCoeff;
  if (denom > 1e-12) {
    let hNode = (hSum + Q + convRhs - keOut) / (sumOut + convCoeff / cp);
    if (ctx.kineticEnergy && keOut !== 0) {
      // The outflow kinetic energy depends on this node's own temperature
      // (through ρ), so solve the scalar energy balance self-consistently
      // instead of lagging KE one outer iteration — at high subsonic Mach
      // the lag destabilises the T-Picard loop.  The fixed point is
      // contractive for subsonic flow (|d(KE)/dh| = (γ−1)M² < 1 for an
      // ideal gas), so a few iterations settle it.
      for (let ke = 0; ke < 60; ke++) {
        const Ttry = fluidOf(nodeId).temperatureFromEnthalpy(Pcurr, hNode);
        const rhoTry = fluidOf(nodeId).density(Pcurr, Ttry);
        let keOutTry = 0;
        for (let j = 0; j < nBranch; j++) {
          const b = branches[j];
          const mdot = X[nInt + j];
          if (b.from === nodeId && mdot > 0) {
            keOutTry += mdot * kineticEnergyAt(j, "from", mdot, rhoTry);
          } else if (b.to === nodeId && mdot < 0) {
            keOutTry += -mdot * kineticEnergyAt(j, "to", mdot, rhoTry);
          }
        }
        const hNext =
          (hSum + Q + convRhs - keOutTry) / (sumOut + convCoeff / cp);
        const settled =
          Math.abs(hNext - hNode) <= 1e-10 * Math.max(1, Math.abs(hNode));
        hNode = hNext;
        if (settled) break;
      }
    }
    let newT = fluidOf(nodeId).temperatureFromEnthalpy(Pcurr, hNode);
    if (ctx.kineticEnergy) {
      // Damp the outer T-Picard.  The stagnation-enthalpy coupling closes a
      // T → ρ → V → T feedback loop through the momentum solve which
      // limit-cycles undamped near choking (per-outer |ΔT| plateaus above
      // the settle bar and the solve never certifies).  The damping is
      // ADAPTIVE per node: a sign flip of the raw update means the local
      // Picard slope is < −1, so the relaxation is halved until the damped
      // map contracts (λ < 2/(1+|slope|)); steady same-sign progress lets it
      // recover.  The fixed point is unchanged.
      const rawDelta = newT - oldTVal;
      let relaxT = 0.5;
      const damp = tPicardDamp?.get(nodeId);
      if (damp) {
        relaxT =
          damp.lastDelta * rawDelta < 0
            ? Math.max(0.02, damp.relax * 0.5)
            : Math.min(0.5, damp.relax * 1.2);
      }
      tPicardDamp?.set(nodeId, { lastDelta: rawDelta, relax: relaxT });
      newT = oldTVal + relaxT * rawDelta;
    }
    state.nodeT.set(nodeId, newT);
    return Math.abs(newT - oldTVal);
  }
  return 0;
}

/** Species transport update (operator-split, once per outer iteration):
 *  upwind advection of the mass fractions at the inner Newton's mdots,
 *  implicit in the node mass for transient (frozen at the step-start
 *  composition so repeated outer iterations do not over-advance), explicit
 *  mixing balance for steady.  Renormalises to ΣY = 1. */
function updateSpeciesTransport(
  ctx: SolverContext,
  state: StepState,
  X: number[],
  dt: number | undefined,
  prevState: StepState | undefined,
): void {
  if (!ctx.hasSpecies || !state.nodeY) return;
  const { nodeMap, internalIds, branches, nInt, nBranch } = ctx;
  for (let i = 0; i < nInt; i++) {
    const nodeId = internalIds[i];
    const node = nodeMap.get(nodeId)!;
    const Yold = state.nodeY.get(nodeId)!;
    const Ynew: Record<string, number> = {};
    const spNames = ctx.speciesNames;
    const sumInY: Record<string, number> = {};
    for (const sp of spNames) sumInY[sp] = 0;
    let sumOut = 0;
    for (let j = 0; j < nBranch; j++) {
      const b = branches[j];
      const mdot = X[nInt + j];
      if (b.to === nodeId && mdot > 0) {
        const Yup = state.nodeY.get(b.from)!;
        for (const sp of spNames) sumInY[sp] += mdot * (Yup[sp] ?? 0);
      } else if (b.from === nodeId && mdot < 0) {
        const Yup = state.nodeY.get(b.to)!;
        for (const sp of spNames) sumInY[sp] += -mdot * (Yup[sp] ?? 0);
      } else if (b.from === nodeId && mdot > 0) {
        sumOut += mdot;
      } else if (b.to === nodeId && mdot < 0) {
        sumOut += -mdot;
      }
    }
    const V = node.volume ?? 0;
    const rho = state.nodeRho.get(nodeId)!;
    const m = rho * V;
    // For transient, freeze the old composition at the beginning of the step
    // (prevState) so repeated outer iterations do not over-advance species.
    const Yfrozen =
      dt !== undefined && prevState !== undefined && prevState.nodeY
        ? prevState.nodeY.get(nodeId)!
        : Yold;
    if (dt !== undefined && prevState !== undefined) {
      const denom = m / dt + sumOut;
      if (denom > 1e-30) {
        for (const sp of spNames) {
          Ynew[sp] = ((m / dt) * (Yfrozen[sp] ?? 0) + sumInY[sp]) / denom;
        }
      } else {
        for (const sp of spNames) Ynew[sp] = Yfrozen[sp] ?? 0;
      }
    } else {
      if (sumOut > 1e-30) {
        for (const sp of spNames) {
          Ynew[sp] = sumInY[sp] / sumOut;
        }
      } else {
        for (const sp of spNames) Ynew[sp] = Yold[sp] ?? 0;
      }
    }
    // Renormalize with documented convention: divide by total sum to keep ΣY=1
    let sumY = 0;
    for (const sp of spNames) sumY += Ynew[sp];
    if (sumY > 0) {
      for (const sp of spNames) Ynew[sp] /= sumY;
    }
    // Guard against round-off clipping
    for (const sp of spNames) {
      Ynew[sp] = Math.max(0, Math.min(1, Ynew[sp]));
    }
    state.nodeY.set(nodeId, Ynew);
  }
}

/** Refresh the derived properties (ρ, μ [, T, quality, phase]) of every
 *  fluid node from the just-published P (+ h or T).  Real-fluid property
 *  failures keep the previous values rather than crashing — the inner-loop
 *  residual was already converged at this point. */
function refreshNodeProperties(ctx: SolverContext, state: StepState): void {
  const fluidOf = (id: string) => ctx.fluidAssignment.node(id);
  for (const nodeId of [...ctx.internalIds, ...ctx.boundaryIds]) {
    const P = state.nodeP.get(nodeId)!;
    const T = state.nodeT.get(nodeId)!;
    const fluid = fluidOf(nodeId);
    if (fluid instanceof RealFluid) {
      let h = state.nodeH!.get(nodeId)!;
      const [, clampedH] = clampToValidPH(fluid.fluidName, P, h);
      h = clampedH;
      state.nodeH!.set(nodeId, h);
      try {
        const ph = safeStatePH(fluid, P, h, `node ${nodeId} post-step update`);
        state.nodeRho.set(nodeId, ph.rho);
        state.nodeMu.set(nodeId, ph.mu);
        state.nodeT.set(nodeId, ph.T);
        state.nodeQuality!.set(nodeId, ph.quality);
        state.nodePhase!.set(nodeId, ph.phase);
      } catch {
        // CoolProp abort or property failure: keep previous rho/mu/T/quality
        // so the solver can continue. The inner-loop residual was already
        // converged; skipping the post-update sync is safer than crashing.
      }
    } else {
      if (ctx.hasSpecies && ctx.mixtureFluid && state.nodeY) {
        const Y = state.nodeY.get(nodeId)!;
        state.nodeRho.set(nodeId, ctx.mixtureFluid.densityMix(P, T, Y));
        state.nodeMu.set(nodeId, ctx.mixtureFluid.viscosityMix(P, T, Y));
      } else {
        state.nodeRho.set(nodeId, fluid.density(P, T));
        state.nodeMu.set(nodeId, fluid.viscosity(P, T));
      }
      // Mixed-EOS network: the state carries nodeH for every node — keep the
      // analytic entries in lockstep with the just-published T so any h
      // reader (warm starts, boundary flux terms) never sees a stale value.
      if (state.nodeH?.has(nodeId)) {
        state.nodeH.set(nodeId, fluid.enthalpyPT(P, T));
      }
    }
  }
}

/** Node-local stiff chemistry sub-step (transient only, operator-split).
 *  Runs once per time step after the outer loop converges. */
function runChemistrySubStep(
  ctx: SolverContext,
  state: StepState,
  dt: number | undefined,
): void {
  if (
    dt === undefined ||
    !ctx.hasSpecies ||
    !ctx.reactions ||
    ctx.reactions.length === 0 ||
    !ctx.mixtureFluid ||
    !state.nodeY
  ) {
    return;
  }
  for (const nodeId of ctx.internalIds) {
    const P = state.nodeP.get(nodeId)!;
    const T = state.nodeT.get(nodeId)!;
    const Y = state.nodeY.get(nodeId)!;
    const cp = ctx.mixtureFluid.cpMix(P, T, Y);
    const Rmix = ctx.mixtureFluid.R_mix(Y);
    const y0: number[] = [];
    for (const sp of ctx.speciesNames) y0.push(Y[sp] ?? 0);
    y0.push(T);

    const f = makeChemistryRHS(P, ctx.reactions, ctx.speciesNames, Rmix, cp);
    try {
      const chemRes = integrateBDF1(f, y0, 0, dt, {
        atol: 1e-10,
        rtol: 1e-6,
        dtMax: dt,
        dtMin: dt * 1e-6,
        maxSteps: 1000,
      });
      const Ynew: Record<string, number> = {};
      let sumY = 0;
      for (let i = 0; i < ctx.speciesNames.length; i++) {
        Ynew[ctx.speciesNames[i]] = Math.max(0, Math.min(1, chemRes.y[i]));
        sumY += Ynew[ctx.speciesNames[i]];
      }
      if (sumY > 0) {
        for (const sp of ctx.speciesNames) Ynew[sp] /= sumY;
      }
      state.nodeY.set(nodeId, Ynew);
      state.nodeT.set(nodeId, chemRes.y[ctx.speciesNames.length]);
    } catch {
      // If the stiff ODE integrator fails, skip chemistry for this node
      // so the solver can continue.  The transport step already updated Y.
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// One complete solve attempt
// ──────────────────────────────────────────────────────────────────────────

function solveStateStepAttempt(
  ctx: SolverContext,
  state: StepState,
  options: SolveStepOptions,
): SolveStepResult {
  const { nodeMap, internalIds, nInt, nBranch } = ctx;
  const maxOuterDefault = 1000;
  const maxIterDefault = 200;
  const maxIterations = options.maxIterations ?? maxIterDefault;
  const {
    dt,
    t,
    tol,
    relaxation,
    prevState,
    maxOuter = maxOuterDefault,
  } = options;
  const relax = relaxation;
  // Extended system: for real-fluid transient single-phase, solve [P, mdot, h]
  // simultaneously.  The 3×3 Jacobian is ill-conditioned in the two-phase dome
  // because density collapses and the FD derivatives become noisy, so we fall
  // back to the segregated (Picard-like) outer loop for dome nodes.
  let anyNodeTwoPhase = false;
  if (ctx.isRealFluid && dt !== undefined) {
    anyNodeTwoPhase = anyTwoPhaseNode(ctx, state);
  }

  // For steady real-fluid h-updates, full relaxation is stable because the energy
  // balance is linear in h when P/md are frozen. Under-relaxation was causing
  // 40+ outer iterations to hit the 1e-7 tolerance.
  // For transient, use heavy under-relaxation (0.1) to keep the inner loop stable
  // when density collapses during flashing (two-phase dome crossing).
  let hRelax =
    dt !== undefined
      ? anyNodeTwoPhase
        ? Math.min(relax, 0.05)
        : Math.min(relax, 0.5)
      : 1.0;
  const useExtendedSystem = ctx.isRealFluid && dt !== undefined;
  // Coupled steady enthalpy system (settings.kineticEnergy): x = [P, ṁ, h]
  // with stagnation-enthalpy energy rows solved simultaneously for EVERY
  // fluid class — see useCoupledHMode in ./kernel.ts.
  const useCoupledH = useCoupledHMode(ctx, dt);
  // certifyAfterCoupling (EXPERIMENTAL, opt-in): when on, the certifying
  // scaled residual is re-measured AFTER the correlation h-map update and
  // wall re-solve of each outer iteration, and the best-outer / hopeless-step
  // bookkeeping tracks that post-coupling value (the pre-coupling inner-Newton
  // residual converges against the PREVIOUS outer's coupling and would
  // falsely certify — the energy-certification finding).  Only meaningful
  // for the extended system (real-fluid transient).
  const checkAfterCoupling =
    options.certifyAfterCoupling === true && useExtendedSystem;
  // Column layout of the unknown vector (see ./dofMap.ts).  Every index below
  // is resolved through `dof` rather than block arithmetic, so the scaling,
  // clamping and publish loops stay correct as the energy block changes shape.
  const dof = createUniformDofMap(ctx, {
    useExtendedSystem,
    useCoupledH,
  });
  const nVar = dof.nVar;

  // The coupled h-system reads every node's enthalpy — boundaries included —
  // through state.nodeH.  Real-fluid nodes already carry an authoritative h;
  // analytic nodes get h = h(P, T) from the current state, which is exact
  // (their enthalpy is a function of T alone), so a warm start after a
  // legacy solve can never be stale.
  if (useCoupledH) {
    if (!state.nodeH) state.nodeH = new Map();
    for (const id of nodeMap.keys()) {
      const f = ctx.fluidAssignment.node(id);
      if (!(f instanceof RealFluid)) {
        state.nodeH.set(
          id,
          f.enthalpyPT(state.nodeP.get(id)!, state.nodeT.get(id)!),
        );
      }
    }
  }

  // ── Warm start: assemble the unknown vector from the current state ─────
  const X = new Array(nVar).fill(0);
  for (const id of internalIds) X[dof.pressureCol(id)!] = state.nodeP.get(id)!;
  for (let j = 0; j < nBranch; j++) X[dof.mdotCol(j)] = state.mdots[j];
  if (useCoupledH) {
    for (const id of dof.energyNodes) {
      const f = ctx.fluidAssignment.node(id);
      const [, clampedH] = clampToValidPHFor(
        f,
        X[dof.pressureCol(id)!],
        state.nodeH!.get(id)!,
      );
      X[dof.energyCol(id)!] = clampedH;
    }
  }
  if (useExtendedSystem) {
    // Explicit enthalpy predictor for each internal node.
    // For high-pressure real fluids h and u differ significantly (h = u + P/ρ),
    // so using RHS/mPrev (=u) as the h guess would place the initial iterate
    // far from the physical solution.  We instead keep the previous enthalpy
    // as the starting point and let the Newton method correct it.
    for (const nodeId of dof.energyNodes) {
      const node = nodeMap.get(nodeId)!;
      const hPrev = prevState
        ? prevState.nodeH!.get(nodeId)!
        : state.nodeH!.get(nodeId)!;
      const Pprev = prevState
        ? prevState.nodeP.get(nodeId)!
        : state.nodeP.get(nodeId)!;
      const phPrev = safeStatePH(
        rfOf(ctx, nodeId),
        Pprev,
        hPrev,
        `predictor ${nodeId}`,
      );
      const mPrev = phPrev.rho * (node.volume ?? 0);
      const uPrev = safeInternalEnergyPH(
        rfOf(ctx, nodeId),
        Pprev,
        hPrev,
        `predictor u ${nodeId}`,
      );
      const Q = heatInputOf(ctx, node);
      const dtLocal = dt ?? 0;
      const RHS = mPrev * uPrev + dtLocal * Q;
      // Better h guess: account for the Pv work term that separates h from u
      const hGuess = RHS / mPrev + Pprev / phPrev.rho;
      const [, clampedH] = clampToValidPH(
        rfOf(ctx, nodeId).fluidName,
        X[dof.pressureCol(nodeId)!],
        hGuess,
      );
      X[dof.energyCol(nodeId)!] = clampedH;
    }
    // For the extended system we keep the previous mdot as the warm-start
    // rather than overwriting it with the mass-balance predictor.  The
    // mass-balance predictor can set mdot→0 for orifices (where the flow is
    // driven by ΔP, not by density changes), making the 3×3 Jacobian singular
    // at mdot=0 because d(dP)/dmdot=0 for incompressible orifices.  Keeping
    // the previous iterate avoids this singular start and lets the Newton
    // method correct mdot from the momentum balance directly.
    // (The mdot variables were already initialised from state.mdots at the
    // warm-start above, so no further action is needed here.)
  }

  // The residual evaluator and Jacobian builders for this attempt (see
  // ./kernel.ts).  conductorHMap is rebound per outer iteration.
  const kernelEnv: NewtonKernelEnv = {
    ctx,
    state,
    dt,
    t,
    prevState,
    useExtendedSystem,
    useCoupledH,
    dof,
    conductorHMap: computeConductorHMap(ctx, state, undefined, t),
  };
  const kernel = makeKernel(kernelEnv);
  const { computeResidual, hybridJacobian, numericalJacobian } = kernel;

  const startT = new Map<string, number>();
  for (const id of internalIds)
    startT.set(id, prevState ? prevState.nodeT.get(id)! : state.nodeT.get(id)!);

  // Row floors for the CERTIFYING scaled residual: mass rows in kg/s, every
  // other row (momentum in Pa, extended-system energy in W) on the coarse
  // floor.  Deliberately separate from the Newton row scaling sR above —
  // that exists to condition the linear solve and leaves the exact step
  // invariant, whereas this judges whether a step may be called converged.
  const certifyingRowFloor = (row: number): number =>
    dof.kindOf(row) === "P" ? 0.1 : 1e4;

  let outerConverged = false;
  let finalResidual = 1e99;
  let totalIter = 0;
  // Row-floor-scaled residual norm achieved by the MOST RECENT inner loop.
  // Unlike finalResidual (which is only updated when the inner loop meets
  // tol and otherwise stays at the 1e99 sentinel), this always reflects the
  // true convergence of the current iterate on a dimensionless, physically
  // meaningful scale, and it gates the transient real-fluid convergence
  // flag below (residual-certification fix for the chilldown parked-state
  // bug, where steps with ~1e4 W energy residuals were certified as
  // converged).
  let lastInnerBestResScaled = 1e99;
  let returnResidual = 1e99;
  // Consecutive settled outer iterations without inner-Newton convergence
  // (legacy state-motion stall test, NON-extended paths only — the extended
  // system uses the residual-trend detector at the bottom of the outer
  // loop).  Used to break out instead of grinding to maxOuter.
  let stalledOuters = 0;
  // No-progress patience (outer iterations without a > 2 % improvement of
  // the best certifying scaled residual) before an above-bar
  // extended-system step is declared hopeless.  Measured calibration
  // (docs/solver-convergence.md): the subcooled-chilldown t=90 s step
  // descends to ~668 W, pauses through a 12-outer +4 % regime-flip bump,
  // then plunges 40× and certifies (15.9 W) — so the patience must exceed
  // 12; 14 gives ~20 % margin over that measurement.  A limit
  // cycle trips the SAME test ~14 outers after its envelope minimum stops
  // improving (a period-p cycle's minimum is visited once and never
  // improved afterwards — envelope stagnation IS the cycle signature; a
  // separate amplitude-based fast bail was prototyped and rejected: it
  // false-fired on the t=120 regime-flip bounce, 246 W → 2.1 kW →
  // converged 3 outers later).
  const OUTER_PROGRESS_PATIENCE = 14;
  // Hopeless-step detection: best scaled residual seen so far and the outer
  // index it was last improved on (by > 2 %).  A step that cannot converge
  // (e.g. the emergent-venturi no-root discretisation) crawls at < 2 % per
  // outer without ever reaching the convergence bar; break out after a few
  // outers of no improvement instead of burning the full maxOuter budget.
  let scaledBestEver = 1e99;
  let scaledBestOuter = 0;
  // Most-converged outer iterate (scaled residual of the inner Newton's
  // best point).  Restored on a non-converged exit so the returned state is
  // the best discrete solution found, and its scaled value gates the
  // converged flag.
  let bestOuterScaled = 1e99;
  let bestOuterRaw = 1e99;
  let bestOuterState: StepState | undefined;
  let bestOuterPending = false;

  // PTC (pseudo-transient continuation) state for steady real-fluid solves.
  // Adds 1/deltaTau directly to each scaled diagonal to regularize
  // stiff/choked-flow cases.  Global deltaTau ensures pressure variables
  // (structural zero diagonal, zero residual by mass conservation) grow
  // alongside the momentum variables, rather than staying pinned at the
  // initial small value.  DeltaTau grows via SER as the residual drops,
  // recovering exact Newton at deltaTau -> inf.
  const ptcActive =
    dt === undefined &&
    ctx.isRealFluid &&
    (options.steadySolver ?? "ptc") !== "direct";
  const ptcDeltaTau0 = 0.05; // 1/deltaTau = 20, dominant for weak diagonals
  const ptcMinTau = 0.005; // hard floor to prevent freezing death spiral
  const ptcMaxTau = 1e12;
  const ptcGrowthCap = 5;
  const ptcShrinkFactor = 0.2;
  let ptcShrinks = 0;
  const ptcMaxRetries = 5;
  let deltaTau = ptcActive ? ptcDeltaTau0 : 0;

  // SER growth after an accepted step / shrink after a rejected PTC retry.
  const ptcGrow = (ratio: number): void => {
    deltaTau = Math.min(
      deltaTau * Math.min(ptcGrowthCap, Math.max(1, ratio)),
      ptcMaxTau,
    );
  };
  const ptcShrink = (): void => {
    const newTau = Math.max(deltaTau * ptcShrinkFactor, ptcMinTau);
    if (newTau < deltaTau) ptcShrinks++;
    deltaTau = newTau;
  };

  // Trust-region (dogleg) state for real-fluid solves.
  const useTrustRegion =
    (options.globalization ?? "trustRegion") === "trustRegion" &&
    ctx.isRealFluid;
  const trMaxDelta = 1e6;
  const trMinDelta = 1e-12;
  const trMaxRetries = 2;
  let trustRegionDelta = 1.0; // scaled-space radius

  // Adaptive per-node T-Picard damping state for compressible
  // (kineticEnergy) legacy solves — persists across outer iterations.
  const tPicardDamp = ctx.kineticEnergy
    ? new Map<string, { lastDelta: number; relax: number }>()
    : undefined;

  for (let outer = 0; outer < maxOuter; outer++) {
    // The compressible stagnation-T memo is valid only while the frozen
    // state maps are unchanged — drop it at each outer (the previous
    // outer's sync updated nodeT/nodeRho/mdots).
    kernel.invalidateStagTCache();
    // Recompute two-phase flag each outer iteration so that relaxation and
    // tolerance adapt when a node flashes during the first h-update.
    if (ctx.isRealFluid && dt !== undefined) {
      anyNodeTwoPhase = anyTwoPhaseNode(ctx, state);
      hRelax = anyNodeTwoPhase ? Math.min(relax, 0.1) : 1.0;
    }

    // ── Inner Newton loop over x = [P, ṁ (, h)] ─────────────────────────
    let bestResNorm = 1e99;
    let bestX = [...X];
    let consecutiveNoProgress = 0;
    let bestAtMark = 1e99;
    for (let iter = 0; iter < maxIterations; iter++) {
      let R: number[];
      try {
        R = computeResidual(X);
      } catch {
        // Property failure during NR: revert to best known state
        if (bestResNorm < 1e99) {
          for (let k = 0; k < X.length; k++) X[k] = bestX[k];
        }
        break;
      }
      const resNorm = norm2(R);
      if (resNorm < bestResNorm) {
        bestResNorm = resNorm;
        bestX = [...X];
      }
      if (bestResNorm < tol) {
        // inner loop converged
        finalResidual = bestResNorm;
        totalIter = iter;
        for (let k = 0; k < X.length; k++) X[k] = bestX[k];
        break;
      }
      const useHybrid = (options.jacobian ?? "hybrid") === "hybrid";
      const J = useHybrid ? hybridJacobian(X) : numericalJacobian(X);

      // Scaling factors depend on X and R, which are fixed during a single
      // inner-loop iteration.  Compute them once so the PTC retry loop can
      // reuse them with different Jacobians.
      // Column scaling by what the column HOLDS, and row scaling by the
      // conservation law the row expresses — rows share the column layout
      // (mass rows sit opposite P columns, momentum rows opposite ṁ, energy
      // rows opposite the energy block), so one kind lookup serves both.
      const sX: number[] = new Array(nVar).fill(1);
      const sR: number[] = new Array(nVar).fill(1);
      for (let k = 0; k < nVar; k++) {
        switch (dof.kindOf(k)) {
          case "P":
            sX[k] = Math.max(1.0, Math.abs(X[k]), 1e5);
            break;
          case "h":
            sX[k] = Math.max(1e3, Math.abs(X[k]), 1e6);
            break;
          case "T":
            // Absolute temperature is never near zero for a physical state,
            // so |T| is its own characteristic scale; the floor only guards
            // against a degenerate iterate.
            sX[k] = Math.max(1.0, Math.abs(X[k]));
            break;
          default:
            sX[k] = Math.max(1e-6, Math.abs(X[k]), 0.1);
            break;
        }
      }
      for (let i = 0; i < nVar; i++) {
        switch (dof.kindOf(i)) {
          case "P":
            // Mass rows [kg/s].
            sR[i] = Math.max(1e-6, Math.abs(R[i]), 0.1);
            break;
          case "T":
            // Coupled-compressible energy rows are already divided by the
            // node's stagnation-enthalpy throughput in the kernel, so they
            // arrive dimensionless and O(1).  The 1e4 floor the momentum
            // rows need would flatten them against every other row.
            sR[i] = Math.max(1.0, Math.abs(R[i]));
            break;
          case "h":
            // Coupled-h energy rows arrive dimensionless (per-node hPowerRef
            // in the kernel) — same convention as the T rows above.  The
            // extended system's h rows are raw Watts and keep the 1e4 floor.
            sR[i] = useCoupledH
              ? Math.max(1.0, Math.abs(R[i]))
              : Math.max(1.0, Math.abs(R[i]), 1e4);
            break;
          default:
            // Momentum rows [Pa].
            sR[i] = Math.max(1.0, Math.abs(R[i]), 1e4);
            break;
        }
      }

      const Rscaled = R.map((v, i) => v / sR[i]);

      // Scale an unscaled Jacobian and solve for the Newton step dX.
      // Returns both the unscaled step, the scaled step (dY), and the scaled
      // Jacobian so trust-region/dogleg logic can reuse them.
      function scaleAndSolve(
        Junscaled: number[][],
        ptcTau?: number,
      ): { dX: number[]; dY: number[]; Jsc: number[][] } {
        const Jsc: number[][] = Junscaled.map((row) => [...row]);
        for (let i = 0; i < nVar; i++) {
          for (let k = 0; k < nVar; k++) {
            Jsc[i][k] = (Junscaled[i][k] * sX[k]) / sR[i];
          }
        }
        // Genuine PTC: add 1/deltaTau to scaled diagonals that are
        // structurally small or zero (pressure mass-balance rows and any
        // stiff momentum rows).  Well-conditioned rows (|diag| >= 1) are
        // left untouched so easy problems keep their fast Newton path.
        if (ptcTau !== undefined && ptcTau > 0) {
          for (let i = 0; i < nVar; i++) {
            if (Math.abs(Jsc[i][i]) < 1.0) {
              Jsc[i][i] += 1.0 / ptcTau;
            }
          }
        }
        const dXscaled = solveDense(
          Jsc,
          Rscaled.map((v) => -v),
        );
        const dY = dXscaled;
        const dX = dXscaled.map((v, k) => v * sX[k]);
        return { dX, dY, Jsc };
      }

      // Project a trial iterate back into the physically admissible box:
      // positive pressures, bounded mass flows, and — for nodes whose energy
      // unknown is an enthalpy — a state inside the fluid's valid P–h
      // envelope.  Shared by the backtracking line search and the
      // trust-region trial so both enforce identical bounds.
      function clampTrialToBounds(Xtrial: number[]): void {
        for (const id of internalIds) {
          const c = dof.pressureCol(id)!;
          Xtrial[c] = Math.max(1.0, Math.min(1e9, Xtrial[c]));
        }
        for (let j = 0; j < nBranch; j++) {
          const c = dof.mdotCol(j);
          Xtrial[c] = Math.max(-1e3, Math.min(1e3, Xtrial[c]));
        }
        for (const id of dof.energyNodes) {
          if (dof.energyKind(id) !== "h") continue;
          const hCol = dof.energyCol(id)!;
          const [, clampedH] = clampToValidPHFor(
            ctx.fluidAssignment.node(id),
            Xtrial[dof.pressureCol(id)!],
            Xtrial[hCol],
          );
          Xtrial[hCol] = clampedH;
        }
      }

      // Helper: try a step from current X with a given dX and return the best trial.
      function tryStep(dXtry: number[]): {
        trialNorm: number;
        Xtrial: number[];
        reduced: boolean;
      } {
        if (!ctx.isRealFluid) {
          const Xtrial = [...X];
          for (let k = 0; k < X.length; k++) {
            let step = 1.0 * relax * dXtry[k];
            if (ctx.kineticEnergy) {
              // Compressible mode: the discrete equations of a near-choked
              // duct admit spurious mixed subsonic/supersonic roots.  An
              // unclamped Newton step can throw an interior node's pressure
              // across the sonic transition into the wrong root's basin (and
              // the residual there is just as small, so it certifies).  Limit
              // each iteration to a 20 % pressure move, a bounded ṁ move and
              // a 20 % temperature move — pure damping, the converged
              // solution is unchanged.
              const kind = dof.kindOf(k);
              if (kind === "P") {
                const maxStep = 0.2 * Math.max(Math.abs(X[k]), 1e3);
                step = Math.max(-maxStep, Math.min(maxStep, step));
              } else if (kind === "mdot") {
                const maxStep = Math.max(Math.abs(X[k]), 0.1) * 0.5;
                step = Math.max(-maxStep, Math.min(maxStep, step));
              } else {
                const maxStep = 0.2 * Math.max(Math.abs(X[k]), 50);
                step = Math.max(-maxStep, Math.min(maxStep, step));
              }
            }
            Xtrial[k] += step;
          }
          for (const id of internalIds) {
            const c = dof.pressureCol(id)!;
            Xtrial[c] = Math.max(1.0, Math.min(1e9, Xtrial[c]));
          }
          for (const id of dof.energyNodes) {
            // Keep the energy unknown physical: T in [1, 1e5] K directly;
            // an h column gets the SAME temperature box mapped through the
            // node fluid's own h(P, T) (monotone in T), or the tabulated
            // valid P–h envelope for a real fluid.
            const c = dof.energyCol(id)!;
            if (dof.energyKind(id) === "T") {
              Xtrial[c] = Math.max(1.0, Math.min(1e5, Xtrial[c]));
            } else {
              const f = ctx.fluidAssignment.node(id);
              const Ptrial = Xtrial[dof.pressureCol(id)!];
              if (f instanceof RealFluid) {
                const [, clampedH] = clampToValidPHFor(f, Ptrial, Xtrial[c]);
                Xtrial[c] = clampedH;
              } else {
                const hMin = f.enthalpyPT(Ptrial, 1.0);
                const hMax = f.enthalpyPT(Ptrial, 1e5);
                Xtrial[c] = Math.max(hMin, Math.min(hMax, Xtrial[c]));
              }
            }
          }
          let Rtrial: number[];
          try {
            Rtrial = computeResidual(Xtrial);
          } catch {
            Rtrial = R;
          }
          const trialNorm = norm2(Rtrial);
          return { trialNorm, Xtrial, reduced: trialNorm < resNorm };
        } else {
          let alpha = 1.0;
          let bestTrialNorm = 1e99;
          let bestXtrial = [...X];
          for (let backtrack = 0; backtrack < 8; backtrack++) {
            const Xtrial = [...X];
            for (let k = 0; k < X.length; k++) {
              let step = alpha * relax * dXtry[k];
              const kind = dof.kindOf(k);
              if (kind === "P") {
                // No clamp for P — let the line search control the step size
              } else if (kind === "mdot") {
                const maxStep = Math.min(
                  Math.max(Math.abs(X[k]), 0.1) * 0.5,
                  10.0,
                );
                step = Math.max(-maxStep, Math.min(maxStep, step));
              } else {
                // For extended-system h variables, allow the backtracking line search
                // to control the step size rather than clamping to a small fixed bound.
                // The h equation can be stiff (dh ~1e5 J/kg needed); clamping to 5e3
                // forces hundreds of iterations.  The bounds check below and the line
                // search backtrack provide the necessary safeguards.
                if (!useExtendedSystem) {
                  const maxStep = Math.min(Math.abs(X[k]) * 0.05, 5000.0);
                  step = Math.max(-maxStep, Math.min(maxStep, step));
                } else {
                  // Extended system: clamp h-step to avoid overshooting across
                  // the dome, but allow larger steps than the segregated path.
                  // Use a floor so that when h is near zero the solver can still
                  // escape the clamped region (e.g. crossing from positive h to
                  // negative h in the two-phase dome).
                  const maxStep = Math.min(
                    Math.max(Math.abs(X[k]), 1000.0) * 0.5,
                    50000.0,
                  );
                  step = Math.max(-maxStep, Math.min(maxStep, step));
                }
              }
              Xtrial[k] += step;
            }
            clampTrialToBounds(Xtrial);
            let Rtrial: number[];
            try {
              Rtrial = computeResidual(Xtrial);
            } catch {
              alpha *= 0.5;
              continue;
            }
            const trialNorm = norm2(Rtrial);
            if (trialNorm < bestTrialNorm) {
              bestTrialNorm = trialNorm;
              bestXtrial = [...Xtrial];
            }
            if (trialNorm < resNorm) {
              return { trialNorm, Xtrial, reduced: true };
            }
            alpha *= 0.5;
          }
          if (bestTrialNorm < 1e99) {
            return {
              trialNorm: bestTrialNorm,
              Xtrial: bestXtrial,
              reduced: bestTrialNorm < resNorm,
            };
          }
          return { trialNorm: 1e99, Xtrial: [...X], reduced: false };
        }
      }

      // Helper: evaluate a single trial step (no backtracking).  Used by trust-region.
      function evaluateTrial(dXtry: number[]): {
        trialNorm: number;
        Xtrial: number[];
        Rtrial: number[];
      } {
        const Xtrial = [...X];
        for (let k = 0; k < X.length; k++) {
          Xtrial[k] += dXtry[k];
        }
        clampTrialToBounds(Xtrial);
        let Rtrial: number[];
        try {
          Rtrial = computeResidual(Xtrial);
        } catch {
          return { trialNorm: 1e99, Xtrial, Rtrial: R };
        }
        return { trialNorm: norm2(Rtrial), Xtrial, Rtrial };
      }

      let stepAccepted = false;
      let trialNorm = 1e99;
      let Xtrial: number[] = [...X];

      // Trust-region dogleg trial (scaled space): given the Newton step dY
      // and the scaled Jacobian, walk the dogleg path within the current
      // radius, accept on actual/predicted reduction ρ ≥ 0.1 (growing the
      // radius on a strong full-length step), shrink the radius otherwise.
      // On acceptance, publishes trialNorm/Xtrial/stepAccepted.
      function doglegTrial(dY: number[], Jsc: number[][]): boolean {
        const g = matVecTrans(Jsc, Rscaled);
        const normG = norm2(g);
        const Jg = normG > 0 ? matVec(Jsc, g) : [];
        const normJg = norm2(Jg);
        const alpha =
          normG > 0 && normJg > 0 ? (normG * normG) / (normJg * normJg) : 0;
        const dY_C = g.map((v) => -alpha * v);
        const normDY_N = norm2(dY);
        const normDY_C = norm2(dY_C);
        const normR2 = norm2(Rscaled) * norm2(Rscaled);
        for (let trRetry = 0; trRetry < trMaxRetries; trRetry++) {
          let dYtry: number[];
          if (normDY_N <= trustRegionDelta) {
            dYtry = dY;
          } else if (normDY_C >= trustRegionDelta) {
            dYtry = dY_C.map((v) => v * (trustRegionDelta / normDY_C));
          } else {
            const a = dY.map((v, i) => v - dY_C[i]);
            const b = dY_C;
            const aDotB = dot(a, b);
            const aNorm2 = dot(a, a);
            const bNorm2 = dot(b, b);
            const c = bNorm2 - trustRegionDelta * trustRegionDelta;
            const disc = 4 * aDotB * aDotB - 4 * aNorm2 * c;
            let tau = 0;
            if (disc >= 0 && aNorm2 > 0) {
              tau = (-2 * aDotB + Math.sqrt(disc)) / (2 * aNorm2);
              if (tau < 0) tau = 0;
              if (tau > 1) tau = 1;
            }
            dYtry = a.map((v, i) => b[i] + tau * v);
          }
          const dXtry = dYtry.map((v, k) => v * sX[k]);
          const { trialNorm: tn, Xtrial: Xt, Rtrial } = evaluateTrial(dXtry);
          const RtrialScaled = Rtrial.map((v, i) => v / sR[i]);
          const modelRes = matVec(Jsc, dYtry);
          let modelNorm2 = 0;
          for (let i = 0; i < nVar; i++) {
            const v = Rscaled[i] + modelRes[i];
            modelNorm2 += v * v;
          }
          const predVal = 0.5 * (normR2 - modelNorm2);
          const aredVal =
            0.5 * (normR2 - norm2(RtrialScaled) * norm2(RtrialScaled));
          let rho = predVal > 0 ? aredVal / predVal : -1;
          if (!isFinite(rho)) rho = -1;
          if (rho >= 0.1) {
            trialNorm = tn;
            Xtrial = Xt;
            stepAccepted = true;
            if (rho > 0.75 && norm2(dYtry) >= 0.9 * trustRegionDelta) {
              trustRegionDelta = Math.min(trustRegionDelta * 2, trMaxDelta);
            }
            return true;
          } else {
            trustRegionDelta *= 0.25;
            if (trustRegionDelta < trMinDelta) break;
          }
        }
        return false;
      }

      if (!ctx.isRealFluid || !useTrustRegion) {
        // Legacy line-search / direct-step path.
        if (ptcActive) {
          for (let ptcRetry = 0; ptcRetry <= ptcMaxRetries; ptcRetry++) {
            const usePtc = ptcRetry > 0;
            const { dX } = usePtc
              ? scaleAndSolve(J, deltaTau)
              : scaleAndSolve(J);
            const result = tryStep(dX);
            if (result.reduced) {
              trialNorm = result.trialNorm;
              Xtrial = result.Xtrial;
              stepAccepted = true;
              ptcGrow(resNorm / result.trialNorm);
              break;
            } else if (usePtc) {
              ptcShrink();
            }
          }
        } else {
          const { dX } = scaleAndSolve(J);
          const result = tryStep(dX);
          trialNorm = result.trialNorm;
          Xtrial = result.Xtrial;
          stepAccepted = true;
        }
      } else {
        // Trust-region dogleg path (scaled space).
        if (ptcActive) {
          for (let ptcRetry = 0; ptcRetry <= ptcMaxRetries; ptcRetry++) {
            const usePtc = ptcRetry > 0;
            const { dY, Jsc } = usePtc
              ? scaleAndSolve(J, deltaTau)
              : scaleAndSolve(J);
            if (doglegTrial(dY, Jsc)) {
              ptcGrow(resNorm / trialNorm);
              break;
            } else if (usePtc) {
              ptcShrink();
            }
          }
        } else {
          // Non-PTC real-fluid path with trust region.
          const { dX, dY, Jsc } = scaleAndSolve(J);
          if (!doglegTrial(dY, Jsc)) {
            // Fallback to legacy line search if dogleg fails completely.
            const result = tryStep(dX);
            trialNorm = result.trialNorm;
            Xtrial = result.Xtrial;
            stepAccepted = true; // preserve legacy unconditional acceptance for non-PTC path
          }
        }
      }

      if (stepAccepted) {
        for (let k = 0; k < X.length; k++) X[k] = Xtrial[k];
        if (trialNorm < bestResNorm) {
          // Count only SIGNIFICANT improvement as progress: a stuck
          // iteration can otherwise reset the no-progress counter forever
          // with ~1e-5-relative crawl steps (the emergent-venturi no-root
          // grind: 100+ iterations of 7e-5-relative improvements after the
          // descent is done).  The 1e-4 threshold is far below what a
          // converging Newton iteration produces (orders of magnitude),
          // and the tol*100 gate below protects near-converged grinds,
          // so convergence paths are unaffected.
          const relImprove =
            (bestResNorm - trialNorm) / Math.max(bestResNorm, 1e-300);
          bestResNorm = trialNorm;
          bestX = [...X];
          if (relImprove > 1e-4) {
            consecutiveNoProgress = 0;
          } else {
            consecutiveNoProgress++;
            if (
              ctx.isRealFluid &&
              consecutiveNoProgress >= 10 &&
              bestResNorm > tol * 100
            ) {
              break;
            }
          }
        } else {
          consecutiveNoProgress++;
          if (
            ctx.isRealFluid &&
            consecutiveNoProgress >= 10 &&
            bestResNorm > tol * 100
          ) {
            break;
          }
        }
      }
      if (!stepAccepted) {
        break;
      }
      // The line search may have driven bestResNorm below tol on the final
      // iteration; check again before looping.
      if (bestResNorm < tol) {
        // inner loop converged
        finalResidual = bestResNorm;
        totalIter = iter;
        for (let k = 0; k < X.length; k++) X[k] = bestX[k];
        break;
      }
      if (iter === 15) bestAtMark = bestResNorm;
      // Hopeless inner grind: far from convergence (> tol*100) and not
      // improving (< 10 % over the last 20 iterations).  Converging Newton
      // sequences descend many orders of magnitude faster than this once
      // they engage, so the break can only fire on steps that are not
      // going to converge this outer — stopping the grind just makes the
      // retry cascade cheaper (it bounds the emergent-venturi no-root
      // case, which otherwise burns the full maxIterations budget per
      // outer).
      if (
        useExtendedSystem &&
        iter >= 35 &&
        bestResNorm > tol * 100 &&
        bestResNorm > 0.9 * bestAtMark
      ) {
        break;
      }
    }

    // Continue outer loop even if inner loop did not fully converge:
    // restore the best-known state so the next inner loop starts from the
    // most promising point.  This matches the legacy behaviour.
    if (bestResNorm < 1e99) {
      for (let k = 0; k < X.length; k++) X[k] = bestX[k];
    }
    returnResidual = bestResNorm;
    // Row-floor-scaled residual norm of the inner loop's best point, for the
    // transient convergence flag below.  Computed FRESH at the
    // restored bestX because bestResNorm can also improve via the
    // accepted-step update inside the inner loop (where the trial's
    // residual vector is not retained), so a cached scaled value can go
    // stale.  One extra residual evaluation per outer iteration (the inner
    // loop performs hundreds).  Coupling settling between Picard outer
    // iterations is governed separately by the maxDeltaT < fluidTol check.
    if (useExtendedSystem && bestResNorm < 1e99) {
      try {
        const Rb = computeResidual(X);
        let acc = 0;
        for (let i = 0; i < nVar; i++) {
          const v = Rb[i] / certifyingRowFloor(i);
          acc += v * v;
        }
        lastInnerBestResScaled = Math.sqrt(acc);
      } catch {
        lastInnerBestResScaled = 1e99;
      }
    } else {
      lastInnerBestResScaled = bestResNorm;
    }
    if (!checkAfterCoupling) {
      if (lastInnerBestResScaled < scaledBestEver * 0.98) {
        scaledBestEver = lastInnerBestResScaled;
        scaledBestOuter = outer;
      }
      if (lastInnerBestResScaled < bestOuterScaled) {
        bestOuterScaled = lastInnerBestResScaled;
        bestOuterRaw = returnResidual;
        // Snapshot AFTER the sync + wall solve below so the restored state is
        // fully consistent (fluid and walls).  Deferred to a flag here.
        bestOuterPending = true;
      }
    }

    // ── Outer state sync: publish the inner Newton's solution and update
    //    everything solved segregatedly (per-node energy, species, walls) ──
    const oldT = new Map<string, number>();
    for (const id of internalIds) oldT.set(id, state.nodeT.get(id)!);

    let maxDeltaFluidT = 0;
    let maxDeltaFluidH = 0;
    for (let i = 0; i < nInt; i++) {
      const nodeId = internalIds[i];
      const Pcurr = X[dof.pressureCol(nodeId)!];

      if (useCoupledH) {
        // Coupled h-system: h was solved in the inner Newton together with P
        // and ṁ — publish it directly (no segregated energy update, no
        // Picard lag).  Derived properties come from the node fluid's own
        // statePH, whatever its EOS class.
        const hcurr = X[dof.energyCol(nodeId)!];
        const f = ctx.fluidAssignment.node(nodeId);
        if (f instanceof RealFluid) {
          maxDeltaFluidH = Math.max(
            maxDeltaFluidH,
            syncExtendedNode(ctx, state, nodeId, Pcurr, hcurr),
          );
        } else {
          state.nodeH!.set(nodeId, hcurr);
          const ph = f.statePH(Pcurr, hcurr);
          maxDeltaFluidT = Math.max(
            maxDeltaFluidT,
            Math.abs(ph.T - oldT.get(nodeId)!),
          );
          state.nodeT.set(nodeId, ph.T);
          state.nodeRho.set(nodeId, ph.rho);
          state.nodeMu.set(nodeId, ph.mu);
        }
      } else if (useExtendedSystem) {
        // Extended system: h is already converged in the inner loop; just
        // sync state.  In a mixed-EOS network analytic nodes carry h columns
        // too (their statePH is exact), published through the same path but
        // without the real-fluid quality/phase flash.
        const hcurr = X[dof.energyCol(nodeId)!];
        const f = ctx.fluidAssignment.node(nodeId);
        if (f instanceof RealFluid) {
          maxDeltaFluidH = Math.max(
            maxDeltaFluidH,
            syncExtendedNode(ctx, state, nodeId, Pcurr, hcurr),
          );
        } else {
          state.nodeH!.set(nodeId, hcurr);
          const ph = f.statePH(Pcurr, hcurr);
          maxDeltaFluidT = Math.max(
            maxDeltaFluidT,
            Math.abs(ph.T - oldT.get(nodeId)!),
          );
          state.nodeT.set(nodeId, ph.T);
          state.nodeRho.set(nodeId, ph.rho);
          state.nodeMu.set(nodeId, ph.mu);
        }
      } else if (ctx.fluidAssignment.node(nodeId) instanceof RealFluid) {
        maxDeltaFluidH = Math.max(
          maxDeltaFluidH,
          updateSegregatedRealFluidNode(
            ctx,
            state,
            X,
            kernelEnv.conductorHMap,
            nodeId,
            Pcurr,
            hRelax,
            dt,
            prevState,
          ),
        );
      } else {
        maxDeltaFluidT = Math.max(
          maxDeltaFluidT,
          updateLegacyNode(
            ctx,
            state,
            X,
            kernelEnv.conductorHMap,
            nodeId,
            Pcurr,
            startT.get(nodeId)!,
            oldT.get(nodeId)!,
            dt,
            prevState,
            tPicardDamp,
          ),
        );
      }
    }

    updateSpeciesTransport(ctx, state, X, dt, prevState);

    // Publish the inner Newton's pressures and mass flows, then refresh the
    // derived properties (ρ, μ, …) of every node at the updated state.
    for (let i = 0; i < nInt; i++) {
      state.nodeP.set(internalIds[i], X[i]);
    }

    // ── Reacting-junction product-gas property lag (Picard) ─────────────
    // T0 itself is coupled inside the Newton residual (kernel.ts); only the
    // weakly-sensitive property closure (R, γ, μ, cp) of each junction's
    // product continuum is refreshed here, from the model at the
    // just-published (Pc, per-role ṁ).  The swap goes through the LIVE
    // named-fluid map backing fluidAssignment, so the property refresh
    // below and the next inner Newton read the updated gas.  The largest
    // relative parameter change gates certification (settle criterion).
    let maxJunctionParamDelta = 0;
    const swappedProductFluids: IdealGas[] = [];
    if (ctx.junctions.length > 0 && ctx.namedFluidModels) {
      for (const jn of ctx.junctions) {
        const mdotByRole = new Map<string, number>();
        for (const [role, idxs] of jn.roleBranches) {
          let sum = 0;
          for (const jb of idxs) sum += Math.abs(X[nInt + jb]);
          mdotByRole.set(role, sum);
        }
        const pc = state.nodeP.get(jn.nodeId)!;
        const gas = jn.model.evaluate(pc, mdotByRole).gas;
        const current = ctx.namedFluidModels.get(jn.productFluidName);
        if (!(current instanceof IdealGas)) continue; // validated upstream
        const rel = (next: number, prev: number): number =>
          Math.abs(next - prev) / Math.max(Math.abs(prev), 1e-12);
        const delta = Math.max(
          rel(gas.R, current.R),
          rel(gas.gamma, current.gamma),
          rel(gas.mu, current.mu),
          rel(gas.cp, current.cp(pc, gas.T0)),
        );
        maxJunctionParamDelta = Math.max(maxJunctionParamDelta, delta);
        if (delta > 0) {
          const next = new IdealGas(gas.R, gas.gamma, gas.mu, gas.cp);
          ctx.namedFluidModels.set(jn.productFluidName, next);
          swappedProductFluids.push(next);
        }
      }
    }

    refreshNodeProperties(ctx, state);
    // A product-fluid swap re-interprets h = cp·T.  refreshNodeProperties
    // above re-derived state.nodeH from the (continuous) temperature under
    // the NEW cp; the inner Newton's persistent unknown vector must follow,
    // or the next outer warm-starts from enthalpies that decode to
    // (cp_old/cp_new)-scaled temperatures and can strand the Newton.
    if (swappedProductFluids.length > 0 && useCoupledH) {
      for (const id of dof.energyNodes) {
        const f = ctx.fluidAssignment.node(id);
        if (!swappedProductFluids.includes(f as IdealGas)) continue;
        X[dof.energyCol(id)!] = state.nodeH!.get(id)!;
      }
    }
    for (let j = 0; j < nBranch; j++) state.mdots[j] = X[nInt + j];
    // State maps changed — the compressible stagnation-T memo is stale for
    // any residual evaluated below (e.g. certifyAfterCoupling).
    kernel.invalidateStagTCache();

    // Recompute correlation-based h after state update, then solve thermal subsystem
    kernelEnv.conductorHMap = computeConductorHMap(
      ctx,
      state,
      kernelEnv.conductorHMap,
      t,
    );
    let maxDeltaSolidT = 0;
    if (ctx.nSolid > 0) {
      // `t` (the candidate step's END time) is threaded so `{ timeTable }`
      // cp/k curves read their frozen per-step value; undefined in steady
      // solves, where time tables are validation-rejected (solver-side they
      // throw — never silently t = 0).
      const thermalRes = solveThermalSubsystem(
        ctx,
        state,
        { dt, prevState, tol, t },
        kernelEnv.conductorHMap,
      );
      maxDeltaSolidT = thermalRes.maxDeltaT;
    }

    // certifyAfterCoupling (opt-in): re-measure the scaled residual at the
    // POST-wall-solve / POST-h-map state.  X still holds the inner Newton's
    // best point; state.solidT and kernelEnv.conductorHMap now reflect this
    // outer's coupling, so computeResidual(X) measures the residual at the
    // actual candidate-certified state.  This replaces the pre-coupling
    // metric for certification, best-outer tracking, and hopeless-step
    // detection (the pre-coupling value converges against the previous
    // outer's coupling and would falsely certify — the certification-lag
    // finding).
    if (checkAfterCoupling) {
      try {
        const Rc = computeResidual(X);
        let raw = 0;
        let acc = 0;
        for (let i = 0; i < nVar; i++) {
          raw += Rc[i] * Rc[i];
          const v = Rc[i] / certifyingRowFloor(i);
          acc += v * v;
        }
        returnResidual = Math.sqrt(raw);
        lastInnerBestResScaled = Math.sqrt(acc);
      } catch {
        lastInnerBestResScaled = 1e99;
        returnResidual = 1e99;
      }
      if (lastInnerBestResScaled < scaledBestEver * 0.98) {
        scaledBestEver = lastInnerBestResScaled;
        scaledBestOuter = outer;
      }
      if (lastInnerBestResScaled < bestOuterScaled) {
        bestOuterScaled = lastInnerBestResScaled;
        bestOuterRaw = returnResidual;
        bestOuterPending = true;
      }
    }

    if (bestOuterPending) {
      bestOuterPending = false;
      bestOuterState = cloneStepState(state);
    }

    // ── Convergence certification and stall detection ────────────────────
    // The two per-node energy deltas live in different units (Δh in J/kg,
    // ΔT in K) and are judged against ONE fluidTol below.  In a real-fluid
    // network fluidTol is tol·1e7 (h-scale) and in an analytic network
    // tol·1e3 (T-scale) — a 1e4 J·kg⁻¹·K⁻¹ factor, cp-magnitude, so mapping
    // ΔT through it preserves BOTH historical bars exactly: pure networks
    // see one term and the identical test, mixed networks require each
    // class to meet its own bar.
    const maxDeltaFluid = ctx.isRealFluid
      ? Math.max(maxDeltaFluidH, maxDeltaFluidT * 1e4)
      : maxDeltaFluidT;
    const maxDeltaT = Math.max(maxDeltaFluid, maxDeltaSolidT);

    // Node-only debug flag. `process` is not defined in the browser worker.
    if (typeof process !== "undefined" && process.env?.FN_DEBUG_OUTER) {
      console.log(
        `[outer ${outer}] res=${returnResidual.toExponential(2)} maxDeltaT=${maxDeltaT.toExponential(2)}` +
          (ctx.junctions.length > 0
            ? ` jnParamDelta=${maxJunctionParamDelta.toExponential(2)}`
            : ""),
      );
    }

    if (options.onProgress) {
      options.onProgress({ iteration: outer, residual: returnResidual });
    }
    if (options.shouldAbort && options.shouldAbort()) {
      return {
        state,
        converged: outerConverged,
        iterations: totalIter,
        residual: returnResidual,
        residualScaled: lastInnerBestResScaled,
        aborted: true,
      };
    }

    const fluidTol = anyNodeTwoPhase
      ? tol * 1e6
      : ctx.isRealFluid
        ? tol * 1e7
        : tol * 1e3;
    // For transient non-real-fluid we accept outer convergence even if the
    // inner loop is not fully converged: the small time step means the state
    // is close to the previous solution, and the temperature update is
    // regularising.  For steady-state (dt === undefined) we insist on inner
    // convergence to avoid garbage temperature updates from unconverged mass
    // or momentum residuals.  For transient REAL-FLUID we also insist on
    // inner convergence: the two-phase residual is stiff (raw-Watt energy
    // rows), and certifying a step whose inner Newton stalled freezes a
    // physically non-converged state — the subcooled-chilldown parked-state
    // bug (~46 kW sustained enthalpy-flux imbalance reported as a valid
    // steady state).
    // For transient REAL-FLUID steps the convergence flag must distinguish
    // a settled Newton solution from a STALLED iteration: the
    // chilldown parked-state bug certified a state with ~2.5e4 W energy
    // imbalance (scaled norm ~1.3) as converged.  The bar is the row-floor
    // scaled norm < tol*1e3 — the scaled-norm analogue of the state-settling
    // fluidTol (= tol*1e6) used below.  Genuinely converged steps sit at the
    // FD-Newton noise floor (scaled ~1e-5…1e-4, i.e. ~1 W energy imbalance);
    // stalled steps sit at scaled ~0.1…10 (kW-scale imbalance) — a ~1000×
    // separation, so the bar is robust to its exact placement.  The raw-norm
    // tol is unreachable for stiff real-fluid steps (it would require
    // sub-µW energy residuals), which is why the legacy code bypassed the
    // residual check for transient entirely (and thereby hid the bug).
    const innerConverged =
      dt !== undefined
        ? ctx.isRealFluid
          ? lastInnerBestResScaled < tol * 1e3
          : true
        : ctx.isRealFluid
          ? finalResidual < tol
          : // Legacy steady: judge by the CURRENT outer's inner residual,
            // not the sticky finalResidual — an inner loop that converged
            // at an early outer iteration must not certify a later outer
            // whose Newton drifted (observed as a certified supersonic
            // "shock train" in the compressible duct validation).
            returnResidual < tol;
    // Reacting junctions: the product-gas property lag must have settled —
    // a residual measured against properties that materially moved this
    // outer iteration must not certify (see JUNCTION_PARAM_SETTLE_REL).
    const junctionsSettled = maxJunctionParamDelta < JUNCTION_PARAM_SETTLE_REL;
    if (maxDeltaT < fluidTol && innerConverged && junctionsSettled) {
      outerConverged = true;
      break;
    }
    // ── Outer-loop non-convergence detection ────────────────────────────
    // Extended system (transient real-fluid): judge by the RESIDUAL TREND
    // of the certifying scaled residual, never by state motion.  Rationale
    // (measured, docs/solver-convergence.md):
    // near the saturated-liquid dome edge a converging coupled Picard
    // iteration legitimately moves the state by less than fluidTol per
    // outer while the residual descends geometrically (~0.83/outer, no
    // floor, certifying around outer ~19–25 on the subcooled-chilldown
    // trailing steps); the legacy state-motion stall test killed those at
    // outer ~9–25, ~0.5 kW short of the bar, and the 5-outer hopeless rule
    // killed the converging t=90 s step mid-bump.
    //
    // The detector has ONE trigger, above-bar only: the best certifying
    // scaled residual has not improved by > 2 % for OUTER_PROGRESS_PATIENCE
    // outer iterations (scaledBestOuter records the last material
    // improvement).  Any descent faster than ~2 % per 14 outers resets the
    // clock every window and is never cut off — the iteration grinds as
    // long as it is converging.  A flat no-root grind trips it;
    // a limit cycle trips it ~14 outers after its envelope minimum is first
    // visited (a cycle's minimum never improves afterwards — envelope
    // stagnation IS the cycle signature).  Iteration caps are unchanged.
    // Non-extended paths keep the legacy state-motion stall test.
    if (useExtendedSystem) {
      if (
        lastInnerBestResScaled > tol * 1e3 &&
        outer - scaledBestOuter >= OUTER_PROGRESS_PATIENCE
      ) {
        outerConverged = false;
        break;
      }
    } else if (maxDeltaT < fluidTol && junctionsSettled) {
      // Legacy stalled-step test (non-extended paths): the state stopped
      // moving but the inner Newton did not meet tolerance.  A still-moving
      // junction property lag is NOT a stall — the properties keep the
      // residual moving, so let the iteration continue.
      stalledOuters++;
      if (stalledOuters >= 3) {
        outerConverged = false;
        break;
      }
    } else {
      stalledOuters = 0;
    }
    // Soft convergence for real-fluid single-phase: if inner loop is well-converged and
    // the outer loop change is within a reasonable bound, accept it to avoid
    // limit cycles caused by strong P-T-h coupling.  Skip for two-phase where
    // hRelax is already very tight and accuracy matters more.  Uses the
    // CURRENT outer's residual (returnResidual), not the sticky finalResidual
    // — a residual met at an early outer iteration must not certify a later
    // outer whose inner loop drifted far from convergence.
    if (
      ctx.isRealFluid &&
      !anyNodeTwoPhase &&
      outer >= 5 &&
      returnResidual < tol * 10 &&
      maxDeltaT < 10000 * fluidTol
    ) {
      outerConverged = true;
      break;
    }
  }

  // Non-converged exit (stalled / hopeless / maxOuter): restore the
  // most-converged outer iterate found (its residual is measured against
  // its own final coupling), and judge the converged flag by the same bar.
  // For the limit-cycling dome-edge steps this rescues a fully-converged
  // Picard iterate that the oscillating later outers would have buried;
  // for unsolvable steps (no root within reach) the best iterate
  // is still far above the bar and the flag stays false.
  if (!outerConverged && bestOuterState !== undefined) {
    copyStepStateInto(state, bestOuterState);
    returnResidual = bestOuterRaw;
    lastInnerBestResScaled = bestOuterScaled;
    if (useExtendedSystem && dt !== undefined) {
      outerConverged = bestOuterScaled < tol * 1e3;
    }
  }

  runChemistrySubStep(ctx, state, dt);

  return {
    state,
    converged: outerConverged,
    iterations: totalIter,
    residual: returnResidual < 1e99 ? returnResidual : finalResidual,
    residualScaled: lastInnerBestResScaled,
    ptcDeltaTau: ptcActive ? deltaTau : undefined,
    ptcShrinks: ptcActive ? ptcShrinks : undefined,
  };
}
