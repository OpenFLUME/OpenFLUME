/**
 * ClosureParams — the calibration surface for PHYSICALLY-MEANINGFUL closure
 * constants.
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * The empirical constants of the physical closure correlations (wall heat
 * transfer, wall friction) are legitimately uncertain quantities: they were
 * fit to particular experimental databases and carry scatter when applied
 * outside them.  Gradient-based calibration of THESE constants against
 * experimental data is standard, defensible practice (it is what GFSSP's
 * own validation exercises effectively do by correlation selection).
 *
 * `NetworkConfig.closureParams` exposes exactly those constants, with
 * defaults equal — bit-for-bit — to the values that were previously
 * hardcoded at the evaluation sites.  A config that leaves `closureParams`
 * unspecified, or specifies only defaults, produces IDENTICAL arithmetic
 * (verified by test: default-vs-unspecified solves are bit-identical).
 *
 * ============================================================================
 * WHAT IS STRUCTURALLY EXCLUDED, AND WHY
 * ============================================================================
 * A calibration that adjusts solver NUMERICS is scientifically indefensible:
 * it would fit the integrator, not the physics.  The following are
 * therefore NOT reachable from this type — there is simply no field for
 * them, and the resolver drops unknown keys, so they cannot be smuggled in:
 *
 *   - PTC constants, trust-region radii/growth, line-search parameters
 *     (solver globalization);
 *   - `hRelax` / `H_RELAX` (correlation under-relaxation across outer
 *     iterations — a convergence device; at a converged fixed point it
 *     vanishes identically);
 *   - `FALLBACK_H_FLOOR` and per-conductor fallback h (guard rails for
 *     failed property evaluations; a clamp that binds is counted in
 *     diagnostics and invalidates the gradient);
 *   - blend sharpnesses / smoothstep edges (tanh blends, the laminar→
 *     turbulent transition blend 2300–4000, the laminar Nu = 3.66/64-Re
 *     asymptotes — regime-boundary numerics, not correlation constants);
 *   - zero-flow thresholds (ZERO_FLOW_THRESHOLD), iteration caps, Newton
 *     tolerances, FD step sizes, time-stepping controls;
 *   - the quality clamp [0.01, 0.99] inside the Miropolskii evaluation
 *     (a singularity guard, not physics).
 *
 * If a reviewer asks "could the fit have touched the integrator?", the
 * answer is structural: no field exists.
 *
 * ============================================================================
 * THE ONE NON-CLOSURE MEMBER
 * ============================================================================
 * `solidCpScale` is NOT a closure constant.  It is a MATERIAL-PROPERTY
 * nuisance parameter: a uniform multiplier on the solid specific-heat
 * curve (or constant).  It exists because the NBS line's copper alloy and
 * its low-temperature cp are unrecorded (CRTech re-analysis flags
 * "copper-alloy heat capacity unknown" as a dominant unknown), and the
 * chilldown-time observable is wall-enthalpy-limited (sensitivity
 * s_cp ≈ +0.7…+1.05).  It is plumbed
 * through the same object for mechanical convenience and is labeled here,
 * in the schema, and in every calibration report as a material property,
 * never as a closure.
 */

// ---------------------------------------------------------------------------
// Correlation parameter groups
// ---------------------------------------------------------------------------

/**
 * Dittus–Boelter single-phase forced convection:
 *   Nu = leadingCoefficient · Re^reynoldsExponent · Pr^prandtlExponent
 * (the heating exponent 0.4 is used uniformly in this codebase).
 * Published values: 0.023 / 0.8 / 0.4 (Dittus & Boelter 1930, as
 * reprinted in standard texts; Colburn analogue 0.023/0.8/1/3).
 */
export interface DittusBoelterClosureParams {
  leadingCoefficient: number;
  reynoldsExponent: number;
  prandtlExponent: number;
}

/**
 * Miropolskii (1963) dispersed-flow film boiling, as implemented from
 * Cross, Majumdar et al., J. Spacecraft & Rockets 39(2), 2002 (the
 * correlation GFSSP uses for cryogenic chilldown):
 *
 *   Nu = leadingCoefficient
 *        · [Re_g·(x + (ρg/ρf)(1−x))]^reynoldsExponent
 *        · Pr_g^prandtlExponent
 *        · Y
 *   Y = 1 − yCoefficient·(ρf/ρg − 1)^yDensityExponent·(1−x)^yQualityExponent
 *
 * Published values: 0.023 / 0.8 / 0.4 / 0.1 / 0.4 / 0.4.
 */
export interface MiropolskiiClosureParams {
  leadingCoefficient: number;
  reynoldsExponent: number;
  prandtlExponent: number;
  yCoefficient: number;
  yDensityExponent: number;
  yQualityExponent: number;
}

/**
 * Swamee–Jain explicit approximation of the Colebrook–White friction law
 * (Darcy factor):
 *   f = leadingCoefficient / log10( ε/(roughnessDivisor·D)
 *                                   + reynoldsCoefficient/Re^reynoldsExponent )²
 * Published values: 0.25 / 3.7 / 5.74 / 0.9 (Swamee & Jain 1976).
 * (The laminar 64/Re asymptote and the 2300–4000 smoothstep blend are
 * regime numerics and are deliberately NOT exposed — see header.)
 */
export interface SwameeJainClosureParams {
  leadingCoefficient: number;
  roughnessDivisor: number;
  reynoldsCoefficient: number;
  reynoldsExponent: number;
}

// ---------------------------------------------------------------------------
// The config-facing type (all groups optional; partials merge over defaults)
// ---------------------------------------------------------------------------

export interface ClosureParams {
  dittusBoelter?: Partial<DittusBoelterClosureParams>;
  miropolskii?: Partial<MiropolskiiClosureParams>;
  swameeJain?: Partial<SwameeJainClosureParams>;
  /**
   * MATERIAL-PROPERTY nuisance parameter (NOT a closure): uniform
   * multiplier on every solid node's specific heat (constant cp values and
   * T-dependent cp curves alike; k is untouched).  Default 1.
   * Represents the unrecorded copper-alloy heat capacity of the NBS line
   * relative to the NIST OFHC reference curve.
   */
  solidCpScale?: number;
}

/** Fully-resolved form carried by the solver context (no optionals). */
export interface ResolvedClosureParams {
  dittusBoelter: DittusBoelterClosureParams;
  miropolskii: MiropolskiiClosureParams;
  swameeJain: SwameeJainClosureParams;
  solidCpScale: number;
}

/**
 * The published constants — EXACTLY the values hardcoded at the evaluation
 * sites before this type existed.  Do not change these: they are the
 * bit-identity anchor for every pre-closure config and every golden test.
 */
export const DEFAULT_CLOSURE_PARAMS: ResolvedClosureParams = {
  dittusBoelter: {
    leadingCoefficient: 0.023,
    reynoldsExponent: 0.8,
    prandtlExponent: 0.4,
  },
  miropolskii: {
    leadingCoefficient: 0.023,
    reynoldsExponent: 0.8,
    prandtlExponent: 0.4,
    yCoefficient: 0.1,
    yDensityExponent: 0.4,
    yQualityExponent: 0.4,
  },
  swameeJain: {
    leadingCoefficient: 0.25,
    roughnessDivisor: 3.7,
    reynoldsCoefficient: 5.74,
    reynoldsExponent: 0.9,
  },
  solidCpScale: 1,
};

/**
 * Merge user partials over the published defaults.  Only keys present in
 * the DEFAULT group are copied — unknown keys are DROPPED (structural
 * exclusion of solver numerics — see header): an object smuggled in with
 * e.g. `{ hRelax: 0.9 }` resolves to exactly the defaults.  Explicit
 * `undefined` values are also ignored.
 */
function mergeDefined<T extends object>(base: T, over?: Partial<T>): T {
  const out = { ...base };
  if (!over) return out;
  for (const k of Object.keys(base) as Array<keyof T>) {
    const v = over[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function resolveClosureParams(p?: ClosureParams): ResolvedClosureParams {
  if (!p) return DEFAULT_CLOSURE_PARAMS;
  return {
    dittusBoelter: mergeDefined(
      DEFAULT_CLOSURE_PARAMS.dittusBoelter,
      p.dittusBoelter,
    ),
    miropolskii: mergeDefined(
      DEFAULT_CLOSURE_PARAMS.miropolskii,
      p.miropolskii,
    ),
    swameeJain: mergeDefined(DEFAULT_CLOSURE_PARAMS.swameeJain, p.swameeJain),
    solidCpScale: p.solidCpScale ?? DEFAULT_CLOSURE_PARAMS.solidCpScale,
  };
}

/** Validation for validate.ts.  Returns error strings (empty = valid). */
export function validateClosureParams(p: ClosureParams): string[] {
  const errs: string[] = [];
  const pos = (v: number | undefined, name: string) => {
    if (
      v !== undefined &&
      !(typeof v === "number" && Number.isFinite(v) && v > 0)
    ) {
      errs.push(
        `closureParams.${name} must be a positive finite number (got ${v})`,
      );
    }
  };
  const fin = (v: number | undefined, name: string) => {
    if (v !== undefined && !(typeof v === "number" && Number.isFinite(v))) {
      errs.push(`closureParams.${name} must be finite (got ${v})`);
    }
  };
  pos(p.dittusBoelter?.leadingCoefficient, "dittusBoelter.leadingCoefficient");
  fin(p.dittusBoelter?.reynoldsExponent, "dittusBoelter.reynoldsExponent");
  fin(p.dittusBoelter?.prandtlExponent, "dittusBoelter.prandtlExponent");
  pos(p.miropolskii?.leadingCoefficient, "miropolskii.leadingCoefficient");
  fin(p.miropolskii?.reynoldsExponent, "miropolskii.reynoldsExponent");
  fin(p.miropolskii?.prandtlExponent, "miropolskii.prandtlExponent");
  // yCoefficient = 0 is physically admissible (degenerates Y to 1).
  if (p.miropolskii?.yCoefficient !== undefined) {
    const v = p.miropolskii.yCoefficient;
    if (!(typeof v === "number" && Number.isFinite(v) && v >= 0)) {
      errs.push(
        `closureParams.miropolskii.yCoefficient must be a non-negative finite number (got ${v})`,
      );
    }
  }
  fin(p.miropolskii?.yDensityExponent, "miropolskii.yDensityExponent");
  fin(p.miropolskii?.yQualityExponent, "miropolskii.yQualityExponent");
  pos(p.swameeJain?.leadingCoefficient, "swameeJain.leadingCoefficient");
  pos(p.swameeJain?.roughnessDivisor, "swameeJain.roughnessDivisor");
  pos(p.swameeJain?.reynoldsCoefficient, "swameeJain.reynoldsCoefficient");
  fin(p.swameeJain?.reynoldsExponent, "swameeJain.reynoldsExponent");
  pos(p.solidCpScale, "solidCpScale");
  return errs;
}
