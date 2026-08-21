/**
 * Optional, low-overhead solver diagnostics for gradient-hazard detection.
 *
 * Two known hazards need cheap detection so a calibration study can assert
 * they are not firing during a parameter sweep:
 *
 *  1. `hFloorClampCount` — the FALLBACK_H_FLOOR (or user-supplied h floor)
 *     clamp in evaluateConvectionH is a hard `max(floor, hRaw)`.  When it
 *     binds, the correlation's gradient w.r.t. its coefficients (and w.r.t.
 *     the state) is exactly zero — a clipped gradient that silently flattens
 *     any calibration objective.
 *
 *  2. `statePHFallbackCount` — safeStatePH's cascading fallback chain.  Tiers
 *     1–3 (fresh AbstractState, direct PropsSI, saturation-dome analytic) are
 *     slower but physically correct; tier 4 (`lastResort`) returns a
 *     PHYSICALLY WRONG but finite state purely to keep the solver alive — if
 *     it ever fires, results are silently corrupted.
 *
 * Design: module-level counters with reset/snapshot.  Default solver
 * behaviour is unchanged and the cost is one branch + increment per event
 * (only on the clamp/fallback paths, which are rare).  Counters are global
 * to the process/worker; snapshot before and after a solve to attribute
 * counts to that solve:
 *
 *   resetSolverDiagnostics();
 *   const res = solveTransient(cfg);
 *   const diag = getSolverDiagnostics();
 */
export interface StatePHFallbackTiers {
  /** Tier 1: recovered via a fresh CoolProp AbstractState after a cached-state abort. */
  freshFactory: number;
  /** Tier 2: recovered via direct CoolProp PropsSI calls. */
  propsSI: number;
  /** Tier 3: recovered via analytic saturation-dome reconstruction (physically correct). */
  saturationDome: number;
  /** Tier 4: physically-wrong finite placeholder ({T:300, rho:100, ...}) — results corrupted. */
  lastResort: number;
}

/**
 * Darr–Hartwig 2020 (darrHartwig correlation model) guard counters.
 *
 * The LH2 set is fit to a validity envelope (Darr & Hartwig 2020, NTRS
 * 20190029114 — see darrHartwig.ts).  When the local state leaves that
 * envelope the evaluation CLAMPS into a defensible value and counts
 * here — never silently extrapolating:
 *
 *  - relin:          Re_l,in clamped into [1e4, 1e6] (fit: 18,400–433,000).
 *  - twetCrit:       T_wet clamped to ≤ T_cr (Weber blow-up / γ → 0).
 *  - tvapLimit:      T_v clamped to the property package's vapor ceiling.
 *  - frontDistance:  L (distance from quench front) floored at 0.05 m —
 *                    fires routinely AT the rewet front node; informational.
 *  - regimeCollapse: T_sat + 2 K ≥ T_wet,eff (near-critical): T_DNB shifted.
 *  - propertyFailure: a CoolProp evaluation failed; fallback h floor used.
 *  - missingWallTemp: the conductor's wall (non-fluid) endpoint has no solid
 *                     temperature (e.g. fluid–fluid conductor); fallback h.
 */
export interface DarrHartwigDiagnostics {
  validityClamps: {
    relin: number;
    twetCrit: number;
    tvapLimit: number;
    frontDistance: number;
    regimeCollapse: number;
  };
  propertyFailureCount: number;
  missingWallTempCount: number;
}

/**
 * TT-WF (ttWf correlation model) counters — proposed two-temperature /
 * wetted-fraction chilldown closure (src/core/ttWf.ts).
 *
 * The local evaluator (src/core/ttWf.ts) is PURE and reports every guard/
 * limiter event in its result; the caller maps them onto these counters via
 * recordTtWfEvaluation (exactly how darrHartwig's `clamps` array is mapped
 * by correlations.ts).  Cost is one branch + increment per event, only on
 * the rare paths.
 *
 *  - fWetClamp:          proposed f_w pulled back into [0,1] by the bounded
 *                        update (normal at front arrival/departure; a high
 *                        rate signals dt ≫ front-transit time).
 *  - latchSet/latchClear: rewet-hysteresis latch transitions at accepted
 *                        steps (chatter detector: oscillating T_w inside
 *                        ΔT_h must NOT produce repeated transitions).
 *  - invalidInput:       an evaluation was rejected (non-finite or
 *                        non-physical input) — never silently repaired.
 *  - energyLimiter / supplyLimiter: which front-speed ceiling bound the
 *                        advance (u_E < u_L ⇒ energy; u_L ≤ u_E ⇒ liquid
 *                        supply).  'none' (no advance possible) is not
 *                        counted as a limiter activation.
 *  - notIntegrated:      LEGACY Phase-1 guard counter (the model was not yet
 *                        wired into the conductor heat path).  Phase 2 wires
 *                        the model in; this counter must now stay at 0
 *                        forever — it is kept so old snapshots keep their
 *                        shape and any regression to the guard is loud.
 */
export interface TtWfDiagnostics {
  fWetClampCount: number;
  latchSetCount: number;
  latchClearCount: number;
  invalidInputCount: number;
  energyLimiterCount: number;
  supplyLimiterCount: number;
  notIntegratedCount: number;
}

/**
 * Fluid-front transport counters (src/core/fluidFront.ts — the transported
 * cryogenic-front/liquid-availability state gating the TT-WF dry side;
 * docs/fluid-front-transport.md).
 *
 *  - boundsClampCount: the backward-Euler/upwind commit solved an a value
 *    outside [0,1] by MORE than the roundoff guard (1e-12) and was clamped
 *    — a NON-conservative correction.  The scheme is bounded by construction
 *    at a converged accepted step (M-matrix + the solver's own nodal mass
 *    balance), so this MUST be 0 in every nominal run; any occurrence is a
 *    loud signal of an unconverged committed step or a bug.
 *  - invalidInputCount: a commit was rejected (non-finite mdot/mass/a or
 *    non-positive dt) and the previous accepted state was kept — never
 *    silently repaired.
 *  - commitCount: accepted-step commits (ONE per accepted step).  Compared
 *    against the recorded history length by the immutability tests: a
 *    commit during a Newton iteration or a rejected adaptive trial would
 *    inflate this beyond the number of accepted steps.
 */
export interface FluidFrontDiagnostics {
  boundsClampCount: number;
  invalidInputCount: number;
  commitCount: number;
}

export interface SolverDiagnostics {
  /** # times the convection-h floor clamp bound the raw correlation value. */
  hFloorClampCount: number;
  statePHFallbackCount: StatePHFallbackTiers;
  darrHartwig: DarrHartwigDiagnostics;
  ttWf: TtWfDiagnostics;
  fluidFront: FluidFrontDiagnostics;
}

const counters: SolverDiagnostics = {
  hFloorClampCount: 0,
  statePHFallbackCount: {
    freshFactory: 0,
    propsSI: 0,
    saturationDome: 0,
    lastResort: 0,
  },
  darrHartwig: {
    validityClamps: {
      relin: 0,
      twetCrit: 0,
      tvapLimit: 0,
      frontDistance: 0,
      regimeCollapse: 0,
    },
    propertyFailureCount: 0,
    missingWallTempCount: 0,
  },
  ttWf: {
    fWetClampCount: 0,
    latchSetCount: 0,
    latchClearCount: 0,
    invalidInputCount: 0,
    energyLimiterCount: 0,
    supplyLimiterCount: 0,
    notIntegratedCount: 0,
  },
  fluidFront: {
    boundsClampCount: 0,
    invalidInputCount: 0,
    commitCount: 0,
  },
};

export function recordHFloorClamp(): void {
  counters.hFloorClampCount++;
}

export function recordStatePHFallback(tier: keyof StatePHFallbackTiers): void {
  counters.statePHFallbackCount[tier]++;
}

export function recordDarrHartwigValidityClamp(
  kind: keyof DarrHartwigDiagnostics["validityClamps"],
): void {
  counters.darrHartwig.validityClamps[kind]++;
}

export function recordDarrHartwigPropertyFailure(): void {
  counters.darrHartwig.propertyFailureCount++;
}

export function recordDarrHartwigMissingWallTemp(): void {
  counters.darrHartwig.missingWallTempCount++;
}

/** Record one TT-WF counter event (see TtWfDiagnostics for meanings). */
export function recordTtWfEvent(kind: keyof TtWfDiagnostics): void {
  counters.ttWf[kind]++;
}

/**
 * Map one TT-WF evaluation outcome (src/core/ttWf.ts — pure, returns flags)
 * onto the counters.  Caller-side helper, exactly like the darrHartwig
 * `clamps` mapping in correlations.ts: the evaluator itself stays pure.
 *   ok:false            → invalidInputCount
 *   fWetClamped         → fWetClampCount
 *   latch set/cleared   → latchSetCount / latchClearCount
 *   limiter energy/supply (only when the front actually advances,
 *   i.e. latch true and rFront > 0) → energyLimiterCount / supplyLimiterCount
 *
 * Phase-2 caller discipline: this is called ONLY from the accepted-step
 * commit (updateTtWfStates in correlations.ts), once per conductor per
 * accepted step — so these counters track accepted-time events, never
 * Newton-iteration or rejected-trial proposals.  The D-H validity clamps of
 * a TT-WF evaluation are mapped separately on the h-map path
 * (recordDarrHartwigValidityClamp, per evaluation — as for darrHartwig).
 */
export function recordTtWfEvaluation(
  outcome: import("./ttWf").TtWfOutcome,
): void {
  if (!outcome.ok) {
    counters.ttWf.invalidInputCount++;
    return;
  }
  const r = outcome.result;
  if (r.fWetClamped) counters.ttWf.fWetClampCount++;
  if (r.latchTransition === "set") counters.ttWf.latchSetCount++;
  else if (r.latchTransition === "cleared") counters.ttWf.latchClearCount++;
  if (r.proposedState.rewetLatched && r.rFront > 0) {
    if (r.limiter === "energy") counters.ttWf.energyLimiterCount++;
    else if (r.limiter === "supply") counters.ttWf.supplyLimiterCount++;
  }
}

/** Record one fluid-front transport counter event (see FluidFrontDiagnostics). */
export function recordFluidFrontEvent(kind: keyof FluidFrontDiagnostics): void {
  counters.fluidFront[kind]++;
}

/** Deep-copied snapshot of the current counters. */
export function getSolverDiagnostics(): SolverDiagnostics {
  return {
    hFloorClampCount: counters.hFloorClampCount,
    statePHFallbackCount: { ...counters.statePHFallbackCount },
    darrHartwig: {
      validityClamps: { ...counters.darrHartwig.validityClamps },
      propertyFailureCount: counters.darrHartwig.propertyFailureCount,
      missingWallTempCount: counters.darrHartwig.missingWallTempCount,
    },
    ttWf: { ...counters.ttWf },
    fluidFront: { ...counters.fluidFront },
  };
}

export function resetSolverDiagnostics(): void {
  counters.hFloorClampCount = 0;
  counters.statePHFallbackCount.freshFactory = 0;
  counters.statePHFallbackCount.propsSI = 0;
  counters.statePHFallbackCount.saturationDome = 0;
  counters.statePHFallbackCount.lastResort = 0;
  counters.darrHartwig.validityClamps.relin = 0;
  counters.darrHartwig.validityClamps.twetCrit = 0;
  counters.darrHartwig.validityClamps.tvapLimit = 0;
  counters.darrHartwig.validityClamps.frontDistance = 0;
  counters.darrHartwig.validityClamps.regimeCollapse = 0;
  counters.darrHartwig.propertyFailureCount = 0;
  counters.darrHartwig.missingWallTempCount = 0;
  counters.ttWf.fWetClampCount = 0;
  counters.ttWf.latchSetCount = 0;
  counters.ttWf.latchClearCount = 0;
  counters.ttWf.invalidInputCount = 0;
  counters.ttWf.energyLimiterCount = 0;
  counters.ttWf.supplyLimiterCount = 0;
  counters.ttWf.notIntegratedCount = 0;
  counters.fluidFront.boundsClampCount = 0;
  counters.fluidFront.invalidInputCount = 0;
  counters.fluidFront.commitCount = 0;
}
