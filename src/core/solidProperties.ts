/**
 * Temperature-dependent solid properties (specific heat cp, thermal conductivity k).
 *
 * ============================================================================
 * SCHEMA
 * ============================================================================
 * A solid property may be specified as:
 *   - `number`                    — constant (legacy behaviour; the constant code
 *                                   paths in the solver are untouched, so legacy
 *                                   configs are bit-identical);
 *   - `{ table: [[T, v], …] }`    — piecewise-linear in T (K), clamped at the end
 *                                   knots outside the table range;
 *   - `{ material: '<name>' }`    — named preset from the SOLID_MATERIALS registry
 *                                   ('ofhc-copper', 'grcop-84', 'aluminum-6061-t6',
 *                                   'stainless-steel-304', 'stainless-steel-316',
 *                                   'inconel-718', 'ptfe', 'g10-cr-normal',
 *                                   'g10-cr-warp');
 *   - `{ expression, tRange }`    — custom temperature equation in the safe
 *                                   expression language (usercode/expression.ts)
 *                                   with `T` (K) in scope, sampled ONCE at context
 *                                   build over tRange into a
 *                                   PiecewiseLinearProperty (the canonical
 *                                   T-dependent form above — exact
 *                                   value/integral/slope thereafter);
 *   - `{ timeTable: [[t, v], …] }` — piecewise-linear in TIME t (s), clamped
 *                                   outside the knot range; transient only.
 *                                   The solver freezes the value per candidate
 *                                   step at the step's endpoint time (backward
 *                                   Euler), so inside a step a time table uses
 *                                   the exact constant-property pathways.
 *
 * The piecewise-linear table is the canonical T-dependent form: the property value
 * is the linear interpolant, its integral (enthalpy for cp) is the exact piecewise
 * quadratic of that interpolant, and its slope is the exact piecewise-constant
 * derivative — so the solid-energy residual m·(H(T_new) − H(T_old))/dt and its
 * Jacobian m·cp(T_new)/dt are EXACT for the represented curve (no per-step
 * quadrature error, no frozen-cp lag across a large ΔT step).
 *
 * ============================================================================
 * NAMED-MATERIAL PROVENANCE — OFHC COPPER
 * ============================================================================
 * Source: NIST Cryogenic Technologies Group, Cryogenic Material Properties
 * Database, "Material Properties: OFHC Copper (UNS C10100/C10200)",
 * rev. 02/03/2010.
 *   https://trc.nist.gov/cryogenics/materials/OFHC%20Copper/OFHC_Copper_rev1.htm
 * Program paper: Marquardt, Le & Radebaugh, "Cryogenic Material Properties
 * Database", Proc. 11th Int. Cryocooler Conf., 2000:
 *   https://trc.nist.gov/cryogenics/Papers/Material_Properties/2000-Cryogenic_Material_Properties_Database.pdf
 * Companion compilation (same critically-evaluated data base):
 *   Simon, Drexler & Reed, "Properties of Copper and Copper Alloys at Cryogenic
 *   Temperatures", NIST Monograph 177 (1992),
 *   https://nvlpubs.nist.gov/nistpubs/Legacy/MONO/nistmonograph177.pdf
 *
 * SPECIFIC HEAT (cp, J/(kg·K)):
 *   log10(cp) = Σ_j c_j·(log10 T)^j,  T in K.
 *   Coefficients c_0..c_8 (NIST labels a..i — all digits significant):
 *     −1.91844, −0.15973, 8.61013, −18.996, 21.9661, −12.7328, 3.54322, −0.3797, 0
 *   Data/equation range: 4–300 K.
 *   Stated curve-fit error relative to data: 10 % (T < 15 K); 5 % (T ≥ 15 K).
 *   cp is essentially RRR-independent (impurity affects only the electron term
 *   below ~10 K); the database publishes a single cp curve.
 *
 * THERMAL CONDUCTIVITY (k, W/(m·K)):
 *   log10 k = (a + c·√T + e·T + g·T^1.5 + i·T²)/(1 + b·√T + d·T + f·T^1.5 + h·T²)
 *   Range 4–300 K; stated fit error 1–2 %.  STRONGLY RRR-dependent at low T;
 *   the database publishes curves for RRR = 50/100/150/300/500.  We adopt
 *   RRR = 100 (annealed OFHC tube, NIST's "average sample" curve); the RRR
 *   spread is recorded as a material uncertainty in docs/solid-properties-results.md.
 *
 * The registry stores the NIST fit evaluators and samples them ONCE at module
 * load into piecewise-linear tables (adaptive midpoint refinement to ≤ 0.1 %
 * relative interpolation error — ~50× tighter than the fits' own stated 5 %
 * accuracy).  Sampling is deterministic pure arithmetic.
 */
import type { SolidPropertySpec } from "./schema";
import { compileExpression, ExpressionError } from "./usercode/expression";

// ---------------------------------------------------------------------------
// Piecewise-linear property curve with exact integral
// ---------------------------------------------------------------------------

/**
 * Piecewise-linear-in-T property curve.  Outside the knot range the value is
 * CLAMPED to the end-knot value (slope 0); the integral extends linearly with
 * the clamped value (exact for the clamped curve).
 */
export class PiecewiseLinearProperty {
  /** (T, value) knots, strictly increasing T. */
  readonly knots: Array<[number, number]>;
  /** cumInt[i] = ∫_{knots[0].T}^{knots[i].T} value dT (exact trapezoids). */
  private readonly cumInt: number[];

  constructor(knots: Array<[number, number]>) {
    if (knots.length < 2) {
      throw new Error("Property table needs at least 2 points");
    }
    this.knots = knots.map(([T, v]) => [T, v]);
    this.cumInt = new Array(knots.length).fill(0);
    for (let i = 1; i < knots.length; i++) {
      const [T0, v0] = knots[i - 1];
      const [T1, v1] = knots[i];
      this.cumInt[i] = this.cumInt[i - 1] + 0.5 * (v0 + v1) * (T1 - T0);
    }
  }

  get minT(): number {
    return this.knots[0][0];
  }

  get maxT(): number {
    return this.knots[this.knots.length - 1][0];
  }

  /** Segment index i such that knots[i].T <= T <= knots[i+1].T (clamped). */
  private segment(T: number): number {
    const k = this.knots;
    if (T <= k[0][0]) return 0;
    if (T >= k[k.length - 1][0]) return k.length - 2;
    let lo = 0;
    let hi = k.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (k[m][0] <= T) lo = m;
      else hi = m;
    }
    return lo;
  }

  /** Property value at T (interpolated; clamped outside the knot range). */
  value(T: number): number {
    const k = this.knots;
    if (T <= k[0][0]) return k[0][1];
    if (T >= k[k.length - 1][0]) return k[k.length - 1][1];
    const i = this.segment(T);
    const [T0, v0] = k[i];
    const [T1, v1] = k[i + 1];
    return v0 + ((v1 - v0) * (T - T0)) / (T1 - T0);
  }

  /** Local slope d(value)/dT (piecewise-constant; 0 outside the knot range,
   *  consistent with clamping).  Right-continuous at interior knots. */
  slope(T: number): number {
    const k = this.knots;
    if (T <= k[0][0] || T >= k[k.length - 1][0]) return 0;
    const i = this.segment(T);
    const [T0, v0] = k[i];
    const [T1, v1] = k[i + 1];
    return (v1 - v0) / (T1 - T0);
  }

  /** ∫_{minT}^{T} value dT — EXACT for the piecewise-linear (clamped) curve
   *  (piecewise quadratic inside the range, linear extension outside). */
  integral(T: number): number {
    const k = this.knots;
    if (T <= k[0][0]) return k[0][1] * (T - k[0][0]);
    const last = k.length - 1;
    if (T >= k[last][0])
      return this.cumInt[last] + k[last][1] * (T - k[last][0]);
    const i = this.segment(T);
    const [T0, v0] = k[i];
    const [T1, v1] = k[i + 1];
    const vT = v0 + ((v1 - v0) * (T - T0)) / (T1 - T0);
    return this.cumInt[i] + 0.5 * (v0 + vT) * (T - T0);
  }
}

// ---------------------------------------------------------------------------
// NIST OFHC-copper fits (see provenance header)
// ---------------------------------------------------------------------------

/** NIST cp-fit coefficients c_0..c_8 (their labels a..i). */
const NIST_OFHC_CP_COEF = [
  -1.91844, -0.15973, 8.61013, -18.996, 21.9661, -12.7328, 3.54322, -0.3797, 0,
];

/** NIST k-fit coefficients (a..i) per RRR. */
const NIST_OFHC_K_COEF_BY_RRR: Record<number, number[]> = {
  50: [
    1.8743, -0.41538, -0.6018, 0.13294, 0.26426, -0.0219, -0.051276, 0.0014871,
    0.003723,
  ],
  100: [
    2.2154, -0.47461, -0.88068, 0.13871, 0.29505, -0.02043, -0.04831, 0.001281,
    0.003207,
  ],
  150: [
    2.3797, -0.4918, -0.98615, 0.13942, 0.30475, -0.019713, -0.046897,
    0.0011969, 0.0029988,
  ],
  300: [1.357, 0.3981, 2.669, -0.1346, -0.6683, 0.01342, 0.05773, 0.0002147, 0],
  500: [
    2.8075, -0.54074, -1.2777, 0.15362, 0.36444, -0.02105, -0.051727, 0.0012226,
    0.0030964,
  ],
};

/** RRR adopted for the 'ofhc-copper' preset's k curve (cp is RRR-independent). */
export const OFHC_COPPER_ASSUMED_RRR = 100;

/** NIST OFHC-copper specific-heat fit, J/(kg·K).  Valid 4–300 K. */
export function nistOfhcCopperCpFit(T: number): number {
  const x = Math.log10(T);
  let s = 0;
  let xp = 1;
  for (let j = 0; j < NIST_OFHC_CP_COEF.length; j++) {
    s += NIST_OFHC_CP_COEF[j] * xp;
    xp *= x;
  }
  return Math.pow(10, s);
}

/** NIST OFHC-copper thermal-conductivity fit, W/(m·K).  Valid 4–300 K.
 *  rrr must be one of the published {50, 100, 150, 300, 500}. */
export function nistOfhcCopperKFit(
  T: number,
  rrr: number = OFHC_COPPER_ASSUMED_RRR,
): number {
  const c = NIST_OFHC_K_COEF_BY_RRR[rrr];
  if (!c)
    throw new Error(
      `No NIST OFHC k fit for RRR=${rrr} (have 50/100/150/300/500)`,
    );
  const [a, b, cc, d, e, f, g, h, i] = c;
  const s = Math.sqrt(T);
  const num = a + cc * s + e * T + g * T * s + i * T * T;
  const den = 1 + b * s + d * T + f * T * s + h * T * T;
  return Math.pow(10, num / den);
}

/**
 * Adaptive sampler: piecewise-linear knots for f on [Tmin, Tmax], bisecting any
 * interval whose midpoint deviates from the chord by more than `tol` (relative).
 */
function sampleAdaptive(
  f: (T: number) => number,
  Tmin: number,
  Tmax: number,
  tol: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [
    [Tmin, f(Tmin)],
    [Tmax, f(Tmax)],
  ];
  const stack: Array<[number, number]> = [[Tmin, Tmax]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const m = 0.5 * (a + b);
    const fm = f(m);
    const lin = 0.5 * (f(a) + f(b));
    if (Math.abs(fm - lin) / Math.abs(fm) > tol) {
      pts.push([m, fm]);
      stack.push([a, m], [m, b]);
    }
  }
  pts.sort((x, y) => x[0] - y[0]);
  return pts;
}

/** One sampled sub-range of a composite curve: f on [Tmin, Tmax]. */
interface CurveSegment {
  f: (T: number) => number;
  Tmin: number;
  Tmax: number;
}

/**
 * Sample a piecewise-defined curve segment-by-segment and concatenate the
 * knots.  Shared boundary temperatures are emitted once, with the EARLIER
 * segment's value kept (relevant only for the NIST 316 two-fit cp join at
 * 50 K, where the two published fits differ by 0.15 % — far inside their
 * 2 % stated accuracy; every other join here is continuous by construction).
 */
function sampleComposite(
  segments: CurveSegment[],
  tol: number,
): Array<[number, number]> {
  const knots: Array<[number, number]> = [];
  for (const s of segments) {
    for (const p of sampleAdaptive(s.f, s.Tmin, s.Tmax, tol)) {
      const last = knots[knots.length - 1];
      if (last && Math.abs(last[0] - p[0]) < 1e-9 * Math.abs(p[0])) continue;
      knots.push(p);
    }
  }
  return knots;
}

// ---------------------------------------------------------------------------
// Shared NIST log-log fit form (all NIST cryogenic-database cp fits and most
// k fits):  log10(y) = Σ_j c_j·(log10 T)^j,  T in K.
// ---------------------------------------------------------------------------

function nistLogLogFit(coef: readonly number[], T: number): number {
  const x = Math.log10(T);
  let s = 0;
  let xp = 1;
  for (let j = 0; j < coef.length; j++) {
    s += coef[j] * xp;
    xp *= x;
  }
  return Math.pow(10, s);
}

// ---------------------------------------------------------------------------
// NIST Aluminum 6061-T6 (UNS A96061) fits — data/equation range 4–300 K.
// https://trc.nist.gov/cryogenics/materials/6061%20Aluminum/6061_T6Aluminum_rev.htm
// Stated fit error: cp 5 %, k 0.5 %.
// ---------------------------------------------------------------------------
const NIST_AL6061_CP_COEF = [
  46.6467, -314.292, 866.662, -1298.3, 1162.27, -637.795, 210.351, -38.3094,
  2.96344,
];
const NIST_AL6061_K_COEF = [
  0.07918, 1.0957, -0.07277, 0.08084, 0.02803, -0.09464, 0.04179, -0.00571, 0,
];

export function nistAl6061CpFit(T: number): number {
  return nistLogLogFit(NIST_AL6061_CP_COEF, T);
}
export function nistAl6061KFit(T: number): number {
  return nistLogLogFit(NIST_AL6061_K_COEF, T);
}

// ---------------------------------------------------------------------------
// NIST Stainless Steel 304 (UNS S30400) fits — data range 4–300 K.
// https://trc.nist.gov/cryogenics/materials/304Stainless/304Stainless_rev.htm
// Stated fit error: cp 5 %, k 2 %.
// ---------------------------------------------------------------------------
const NIST_SS304_CP_COEF = [
  22.0061, -127.5528, 303.647, -381.0098, 274.0328, -112.9212, 24.7593,
  -2.239153, 0,
];
const NIST_SS304_K_COEF = [
  -1.4087, 1.3982, 0.2543, -0.626, 0.2334, 0.4256, -0.4658, 0.165, -0.0199,
];

export function nistSs304CpFit(T: number): number {
  return nistLogLogFit(NIST_SS304_CP_COEF, T);
}
export function nistSs304KFit(T: number): number {
  return nistLogLogFit(NIST_SS304_K_COEF, T);
}

// ---------------------------------------------------------------------------
// NIST Stainless Steel 316 (UNS S31600) fits — data range 4–300 K.
// https://trc.nist.gov/cryogenics/materials/316Stainless/316Stainless_rev.htm
// cp is published as TWO fits: 4–50 K and 50–300 K (2 % each); the join at
// 50 K carries a 0.15 % value step (the table keeps the low-range value at
// the shared knot).  The NIST 316 k page publishes the same coefficients as
// 304 (2 %).
// ---------------------------------------------------------------------------
const NIST_SS316_CP_LOW_COEF = [
  12.2486, -80.6422, 218.743, -308.854, 239.5296, -89.9982, 3.15315, 8.44996,
  -1.91368,
];
const NIST_SS316_CP_HIGH_COEF = [
  -1879.464, 3643.198, 76.70125, -6176.028, 7437.6247, -4305.7217, 1382.4627,
  -237.22704, 17.05262,
];
const NIST_SS316_K_COEF = [
  -1.4087, 1.3982, 0.2543, -0.626, 0.2334, 0.4256, -0.4658, 0.165, -0.0199,
];

/** NIST 316 cp fit: the 4–50 K branch below 50 K, the 50–300 K branch above. */
export function nistSs316CpFit(T: number): number {
  return nistLogLogFit(
    T <= 50 ? NIST_SS316_CP_LOW_COEF : NIST_SS316_CP_HIGH_COEF,
    T,
  );
}
export function nistSs316KFit(T: number): number {
  return nistLogLogFit(NIST_SS316_K_COEF, T);
}

// ---------------------------------------------------------------------------
// ANL-75-55 (C. S. Kim, "Thermophysical Properties of Stainless Steels",
// Argonne National Laboratory, Sep 1975; DOE OSTI 4152287) — recommended
// solid-region correlations for Types 304L/316L (the report states the
// property difference from the regular-carbon 304/316 grades is negligible):
//   cp [cal/(g·K)]:  304L: 0.1122 + 3.222e-5·T      316L: 0.1097 + 3.174e-5·T
//   k  [W/(cm·K)]:   304L: 0.08116 + 1.618e-4·T     316L: 0.09248 + 1.571e-4·T
// Converted to SI: ×4184 J/(kg·K) per cal/(g·K); ×100 W/(m·K) per W/(cm·K).
// Underlying experimental data extend to 1620 K (304L cp), 1170 K (316L cp),
// 1600 K (304L k), 1200 K (316L k); the report's smoothed correlations are
// recommended through the solid region to the melting range (1670–1730 K).
// We cap the composite at 1600 K.
// ---------------------------------------------------------------------------
const CAL_G_K_TO_J_KG_K = 4184;
const W_CM_K_TO_W_M_K = 100;

export function anl304LCpFit(T: number): number {
  return (0.1122 + 3.222e-5 * T) * CAL_G_K_TO_J_KG_K;
}
export function anl304LKFit(T: number): number {
  return (8.116e-2 + 1.618e-4 * T) * W_CM_K_TO_W_M_K;
}
export function anl316LCpFit(T: number): number {
  return (0.1097 + 3.174e-5 * T) * CAL_G_K_TO_J_KG_K;
}
export function anl316LKFit(T: number): number {
  return (9.248e-2 + 1.571e-4 * T) * W_CM_K_TO_W_M_K;
}

/** Splice temperature where the cryogenic NIST curves hand off to the
 *  ANL-75-55 high-temperature correlations (K). */
const SS_SPLICE_T0 = 300;
/** End of the documented blend window (K): for T ≥ SS_SPLICE_T1 the curve is
 *  the pure ANL-75-55 correlation. */
const SS_SPLICE_T1 = 500;
/** Cap of the stainless composite range (K) — the ANL-75-55 solid-region
 *  correlations are used up to here (melting range begins 1670–1730 K). */
const SS_MAX_T = 1600;

/**
 * Documented 300 K splice: continuous at T0 (exactly the NIST value), then a
 * linear-decay blend of the NIST-vs-ANL level offset over [T0, T1], and the
 * pure ANL correlation at/above T1.  No jump: f(T0) = fNist(T0) exactly; the
 * offset (up to ~9 % for 304 cp) is removed smoothly across the window.
 */
function anlSplicedHighT(
  fNist: (T: number) => number,
  fAnl: (T: number) => number,
): (T: number) => number {
  const offset = fNist(SS_SPLICE_T0) - fAnl(SS_SPLICE_T0);
  return (T: number) => {
    const w = Math.min(
      1,
      Math.max(0, (T - SS_SPLICE_T0) / (SS_SPLICE_T1 - SS_SPLICE_T0)),
    );
    return fAnl(T) + (1 - w) * offset;
  };
}

// ---------------------------------------------------------------------------
// Inconel 718 (UNS N07718) — Agazhanov, Samoshkin & Kozlovskii,
// "Thermophysical properties of Inconel 718 alloy", J. Phys.: Conf. Ser.
// 1382 (2019) 012175 (open access, CC-BY 3.0), eqs. (1)–(3) for cp and
// eqs. (9)–(10) for k, plus the paper's Table 2 recommended values.
//   cp [J/(g·K)]: 0.362 + 2.118e-4·T                  (298–800 K)
//                 −0.946 + 2.95e-3·T − 1.379e-6·T²    (800–900 K)
//                 0.639 − 3.355e-6·T                  (1070–1361 K; the paper's
//                 own Table 2 evaluates this branch through 1400 K, so it is
//                 applied through 1375 K to meet the k range)
//   k [W/(m·K)]:  5.291 + 0.0152·T + 1.382e-6·T²      (298–800 K)
//                 11.75 + 0.011·T − 9.327e-7·T²       (1173–1375 K)
// The 900–1070 K (cp) and 800–1173 K (k) intervals are the γ″/δ phase-
// transformation region, where the paper reports no single-phase correlation
// (cp "has no physical meaning" there); the catalogue bridges those intervals
// with a straight line between the two branch endpoints and says so in the
// provenance notes.
// ---------------------------------------------------------------------------
function in718CpLow(T: number): number {
  return (0.362 + 2.118e-4 * T) * 1000;
}
function in718CpMid(T: number): number {
  return (-0.946 + 0.295e-2 * T - 1.379e-6 * T * T) * 1000;
}
function in718CpHigh(T: number): number {
  return (0.639 - 3.355e-6 * T) * 1000;
}
function in718KLow(T: number): number {
  return 5.291 + 0.0152 * T + 1.382e-6 * T * T;
}
function in718KHigh(T: number): number {
  return 11.75 + 0.011 * T - 9.327e-7 * T * T;
}

/** Straight-line bridge across a transformation gap: f(a)=fa, f(b)=fb. */
function linearBridge(
  a: number,
  fa: number,
  b: number,
  fb: number,
): (T: number) => number {
  return (T: number) => fa + ((fb - fa) * (T - a)) / (b - a);
}

export const INCONEL718_GAP_CP_K: [number, number] = [900, 1070];
export const INCONEL718_GAP_K_K: [number, number] = [800, 1173];

/** Inconel 718 cp(T) [J/(kg·K)], 298–1375 K (bridge across 900–1070 K). */
export function inconel718CpFit(T: number): number {
  if (T <= 800) return in718CpLow(T);
  if (T <= 900) return in718CpMid(T);
  if (T <= 1070)
    return linearBridge(900, in718CpMid(900), 1070, in718CpHigh(1070))(T);
  return in718CpHigh(T);
}
/** Inconel 718 k(T) [W/(m·K)], 298–1375 K (bridge across 800–1173 K). */
export function inconel718KFit(T: number): number {
  if (T <= 800) return in718KLow(T);
  if (T <= 1173)
    return linearBridge(800, in718KLow(800), 1173, in718KHigh(1173))(T);
  return in718KHigh(T);
}

// ---------------------------------------------------------------------------
// GRCop-84 (Cu-8 at.% Cr-4 at.% Nb) — D. L. Ellis, "Thermophysical Properties
// of GRCop-84", NASA/CR-2000-210055 (2000), NTRS 20000064095.
//   https://ntrs.nasa.gov/citations/20000064095
// Companion liner context: Ellis, NASA/TM-2005-213566 (MCC k ≈ 305–320 W/m·K).
//
// SPECIFIC HEAT (cp, J/(kg·K)): DSC lots, cubic in T, 296–1173 K (eq. 12).
//   cp [J/(g·K)] = 0.2539 + 6.563e-4·T − 8.903e-7·T² + 4.292e-10·T³
//   Converted ×1000.  Do not extrapolate the cubic below 296 K.
//
// THERMAL CONDUCTIVITY (k, W/(m·K)): all-data unweighted regression of laser
// flash + Kohlrausch data (eq. 17).  T in K; ln is natural log.
//   k = 6893 − 3466·ln(T) + 599.5·[ln(T)]² − 34.18·[ln(T)]³
// Published k span ~80–1173 K; catalogue range is the intersection with cp:
// 296–1173 K.  The source also prints a lower 95 % CI (mean − 1.860×Sy.x with
// Sy.x = 6.633 W/m·K) for conservative design; this catalogue stores the
// regression MEAN, not that lower bound.
// ---------------------------------------------------------------------------
export const GRCOP84_TMIN = 296;
export const GRCOP84_TMAX = 1173;

/** GRCop-84 cp(T) [J/(kg·K)], Ellis NASA/CR-2000-210055 eq. 12, 296–1173 K. */
export function grcop84CpFit(T: number): number {
  return (
    1000 * (0.2539 + 6.563e-4 * T - 8.903e-7 * T * T + 4.292e-10 * T * T * T)
  );
}

/** GRCop-84 k(T) [W/(m·K)], Ellis NASA/CR-2000-210055 eq. 17 (regression mean). */
export function grcop84KFit(T: number): number {
  const lnT = Math.log(T);
  return 6893 - 3466 * lnT + 599.5 * lnT * lnT - 34.18 * lnT * lnT * lnT;
}

// ---------------------------------------------------------------------------
// NIST PTFE (Teflon) fits — data/equation range 4–300 K.
// https://trc.nist.gov/cryogenics/materials/Teflon/Teflon_rev.htm
// Stated fit error: cp 1.5 %, k 5 %.
// ---------------------------------------------------------------------------
const NIST_PTFE_CP_COEF = [
  31.88256, -166.51949, 352.01879, -393.44232, 259.98072, -104.61429, 24.99276,
  -3.20792, 0.16503,
];
const NIST_PTFE_K_COEF = [
  2.738, -30.677, 89.43, -136.99, 124.69, -69.556, 23.32, -4.3135, 0.33829,
];

export function nistPtfeCpFit(T: number): number {
  return nistLogLogFit(NIST_PTFE_CP_COEF, T);
}
export function nistPtfeKFit(T: number): number {
  return nistLogLogFit(NIST_PTFE_K_COEF, T);
}

// ---------------------------------------------------------------------------
// NIST G-10 CR (fiberglass epoxy) fits.
// https://trc.nist.gov/cryogenics/materials/G-10%20CR%20Fiberglass%20Epoxy/G10CRFiberglassEpoxy_rev.htm
// cp: 4–300 K (2 %).  k is ANISOTROPIC: normal-direction equation range
// 10–300 K, warp-direction 12–300 K (5 % each).
// ---------------------------------------------------------------------------
const NIST_G10_CP_COEF = [
  -2.4083, 7.6006, -8.2982, 7.3301, -4.2386, 1.4294, -0.24396, 0.015236, 0,
];
const NIST_G10_K_NORMAL_COEF = [
  -4.1236, 13.788, -26.068, 26.272, -14.663, 4.4954, -0.6905, 0.0397, 0,
];
const NIST_G10_K_WARP_COEF = [
  -2.64827, 8.80228, -24.8998, 41.1625, -39.8754, 23.1778, -7.95635, 1.48806,
  -0.11701,
];

export function nistG10CpFit(T: number): number {
  return nistLogLogFit(NIST_G10_CP_COEF, T);
}
export function nistG10KNormalFit(T: number): number {
  return nistLogLogFit(NIST_G10_K_NORMAL_COEF, T);
}
export function nistG10KWarpFit(T: number): number {
  return nistLogLogFit(NIST_G10_K_WARP_COEF, T);
}

// ---------------------------------------------------------------------------
// Named-material registry
// ---------------------------------------------------------------------------

export interface SolidMaterial {
  /** cp(T) knots [K, J/(kg·K)] sampled from the source fit(s) (≤ 0.1 % interp error). */
  cpTable: Array<[number, number]>;
  /** k(T) knots [K, W/(m·K)] sampled from the source fit(s). */
  kTable?: Array<[number, number]>;
  provenance: {
    source: string;
    url: string;
    fitForm: string;
    validityRangeK: [number, number];
    statedFitAccuracy: string;
    rrrAssumed?: number;
    notes: string;
  };
}

/** Sampling tolerance for the registry tables (relative interpolation error
 *  of the piecewise-linear chord vs the source curve). */
const MATERIAL_SAMPLE_TOL = 1e-3;

export const SOLID_MATERIALS: Record<string, SolidMaterial> = {
  "ofhc-copper": {
    cpTable: sampleAdaptive(nistOfhcCopperCpFit, 4, 300, 1e-3),
    kTable: sampleAdaptive(
      (T) => nistOfhcCopperKFit(T, OFHC_COPPER_ASSUMED_RRR),
      4,
      300,
      1e-3,
    ),
    provenance: {
      source:
        'NIST Cryogenic Material Properties Database, "OFHC Copper (UNS C10100/C10200)", rev. 02/03/2010 ' +
        "(Marquardt, Le & Radebaugh 2000; cf. NIST Monograph 177, Simon-Drexler-Reed 1992)",
      url: "https://trc.nist.gov/cryogenics/materials/OFHC%20Copper/OFHC_Copper_rev1.htm",
      fitForm:
        "cp: log10(cp) = 8th-order polynomial in log10(T); " +
        "k: log10(k) = rational polynomial (a+c√T+eT+gT^1.5+iT²)/(1+b√T+dT+fT^1.5+hT²)",
      validityRangeK: [4, 300],
      statedFitAccuracy:
        "cp: 10 % (T<15 K), 5 % (T≥15 K); k: 1–2 % (per NIST database page)",
      rrrAssumed: OFHC_COPPER_ASSUMED_RRR,
      notes:
        "cp is RRR-independent (single NIST curve).  k is strongly RRR-dependent below ~100 K; " +
        "published NIST curves span RRR 50–500.  Tables are adaptive samples of the fits " +
        "(midpoint refinement to ≤1e-3 relative interpolation error).",
    },
  },
  "grcop-84": {
    cpTable: sampleAdaptive(
      grcop84CpFit,
      GRCOP84_TMIN,
      GRCOP84_TMAX,
      MATERIAL_SAMPLE_TOL,
    ),
    kTable: sampleAdaptive(
      grcop84KFit,
      GRCOP84_TMIN,
      GRCOP84_TMAX,
      MATERIAL_SAMPLE_TOL,
    ),
    provenance: {
      source:
        'D. L. Ellis, "Thermophysical Properties of GRCop-84", NASA/CR-2000-210055 (2000); ' +
        "companion liner context Ellis, NASA/TM-2005-213566",
      url: "https://ntrs.nasa.gov/citations/20000064095",
      fitForm:
        "cp [J/(g·K)] = 0.2539 + 6.563e-4·T − 8.903e-7·T² + 4.292e-10·T³ (296–1173 K, converted ×1000).  " +
        "k [W/(m·K)] = 6893 − 3466·ln(T) + 599.5·[ln(T)]² − 34.18·[ln(T)]³ (all-data unweighted regression).",
      validityRangeK: [GRCOP84_TMIN, GRCOP84_TMAX],
      statedFitAccuracy:
        "k: Sy.x = 6.633 W/m·K on the all-data unweighted regression (eq. 17); " +
        "cp: DSC cubic, 296–1173 K (eq. 12).  The source also publishes a lower 95 % CI " +
        "(mean − 1.860×Sy.x) for conservative design; this catalogue stores the regression mean.",
      notes:
        "GRCop-84 is Cu-8 at.% Cr-4 at.% Nb (NASA GRC chamber-liner alloy), not C18150 CuCrZr " +
        "and not OFHC.  The k fit is the all-data regression mean, not the lower 95 % CI.  " +
        "Outside 296–1173 K the value is clamped to the nearest end of the range.  " +
        "Tables are adaptive samples of the fits (≤1e-3 relative interpolation error).",
    },
  },
  "aluminum-6061-t6": {
    cpTable: sampleAdaptive(nistAl6061CpFit, 4, 300, MATERIAL_SAMPLE_TOL),
    // k is sampled at 3e-4: near its ~5 K rise the midpoint-only convergence
    // check underestimates the worst chord deviation at 1e-3 (0.34 % > the
    // 0.2 % table-accuracy target); 3e-4 brings the worst deviation to 0.03 %.
    kTable: sampleAdaptive(nistAl6061KFit, 4, 300, 3e-4),
    provenance: {
      source:
        'NIST Cryogenic Material Properties Database, "6061-T6 Aluminum (UNS A96061)" ' +
        "(Marquardt, Le & Radebaugh 2000)",
      url: "https://trc.nist.gov/cryogenics/materials/6061%20Aluminum/6061_T6Aluminum_rev.htm",
      fitForm: "cp and k: log10(y) = 8th-order polynomial in log10(T)",
      validityRangeK: [4, 300],
      statedFitAccuracy: "cp: 5 %; k: 0.5 % (per NIST database page)",
      notes:
        "Cryogenic range only: outside 4–300 K the value is clamped to the nearest end of the range. " +
        "Tables are adaptive samples of the fits (≤1e-3 relative interpolation error).",
    },
  },
  "stainless-steel-304": {
    cpTable: sampleComposite(
      [
        { f: nistSs304CpFit, Tmin: 4, Tmax: SS_SPLICE_T0 },
        {
          f: anlSplicedHighT(nistSs304CpFit, anl304LCpFit),
          Tmin: SS_SPLICE_T0,
          Tmax: SS_SPLICE_T1,
        },
        { f: anl304LCpFit, Tmin: SS_SPLICE_T1, Tmax: SS_MAX_T },
      ],
      MATERIAL_SAMPLE_TOL,
    ),
    kTable: sampleComposite(
      [
        { f: nistSs304KFit, Tmin: 4, Tmax: SS_SPLICE_T0 },
        {
          f: anlSplicedHighT(nistSs304KFit, anl304LKFit),
          Tmin: SS_SPLICE_T0,
          Tmax: SS_SPLICE_T1,
        },
        { f: anl304LKFit, Tmin: SS_SPLICE_T1, Tmax: SS_MAX_T },
      ],
      MATERIAL_SAMPLE_TOL,
    ),
    provenance: {
      source:
        'NIST Cryogenic Material Properties Database, "304 Stainless (UNS S30400)" (4–300 K); ' +
        'C. S. Kim, "Thermophysical Properties of Stainless Steels", ANL-75-55, Argonne National Lab. (1975), ' +
        "DOE OSTI 4152287 (304L solid-region correlations, ≥300 K)",
      url: "https://trc.nist.gov/cryogenics/materials/304Stainless/304Stainless_rev.htm ; https://www.osti.gov/biblio/4152287",
      fitForm:
        "≤300 K (NIST): log10(y) = 8th-order polynomial in log10(T).  " +
        ">300 K (ANL-75-55): cp = 0.1122 + 3.222e-5·T cal/(g·K); k = 0.08116 + 1.618e-4·T W/(cm·K).",
      validityRangeK: [4, 1600],
      statedFitAccuracy:
        "NIST (≤300 K): cp 5 %, k 2 %.  ANL-75-55 (>300 K): smoothed recommended values; underlying data to " +
        "1620 K (cp) / 1600 K (k)",
      notes:
        "Composite curve.  At 300 K the curve is exactly the NIST value; the level offset to the ANL-75-55 " +
        "correlation (cp ≈ 8 %, k ≈ 15 % at 300 K) is removed by a documented linear blend over 300–500 K, " +
        "so for T ≥ 500 K the curve is the pure ANL-75-55 304L correlation.  ANL-75-55 states the property " +
        "difference between 304 and 304L is negligible.  Capped at 1600 K (below the 1670–1730 K melting " +
        "range); outside 4–1600 K the value is clamped to the nearest end of the range.",
    },
  },
  "stainless-steel-316": {
    cpTable: sampleComposite(
      [
        {
          f: (T) => nistLogLogFit(NIST_SS316_CP_LOW_COEF, T),
          Tmin: 4,
          Tmax: 50,
        },
        {
          f: (T) => nistLogLogFit(NIST_SS316_CP_HIGH_COEF, T),
          Tmin: 50,
          Tmax: SS_SPLICE_T0,
        },
        {
          f: anlSplicedHighT(nistSs316CpFit, anl316LCpFit),
          Tmin: SS_SPLICE_T0,
          Tmax: SS_SPLICE_T1,
        },
        { f: anl316LCpFit, Tmin: SS_SPLICE_T1, Tmax: SS_MAX_T },
      ],
      MATERIAL_SAMPLE_TOL,
    ),
    kTable: sampleComposite(
      [
        { f: nistSs316KFit, Tmin: 4, Tmax: SS_SPLICE_T0 },
        {
          f: anlSplicedHighT(nistSs316KFit, anl316LKFit),
          Tmin: SS_SPLICE_T0,
          Tmax: SS_SPLICE_T1,
        },
        { f: anl316LKFit, Tmin: SS_SPLICE_T1, Tmax: SS_MAX_T },
      ],
      MATERIAL_SAMPLE_TOL,
    ),
    provenance: {
      source:
        'NIST Cryogenic Material Properties Database, "316 Stainless (UNS S31600)" (4–300 K); ' +
        'C. S. Kim, "Thermophysical Properties of Stainless Steels", ANL-75-55, Argonne National Lab. (1975), ' +
        "DOE OSTI 4152287 (316L solid-region correlations, ≥300 K)",
      url: "https://trc.nist.gov/cryogenics/materials/316Stainless/316Stainless_rev.htm ; https://www.osti.gov/biblio/4152287",
      fitForm:
        "≤300 K (NIST): log10(y) = 8th-order polynomial in log10(T); cp is two fits (4–50 K, 50–300 K).  " +
        ">300 K (ANL-75-55): cp = 0.1097 + 3.174e-5·T cal/(g·K); k = 0.09248 + 1.571e-4·T W/(cm·K).",
      validityRangeK: [4, 1600],
      statedFitAccuracy:
        "NIST (≤300 K): cp 2 %, k 2 %.  ANL-75-55 (>300 K): smoothed recommended values; underlying data to " +
        "1170 K (cp) / 1200 K (k), extrapolated by ANL through the solid region",
      notes:
        "Composite curve with the same splice discipline as stainless-steel-304: exact NIST value at 300 K, " +
        "documented linear blend of the level offset over 300–500 K, pure ANL-75-55 316L correlation for " +
        "T ≥ 500 K.  The NIST 316 cp fits join at 50 K with a 0.15 % step (within their 2 % accuracy).  " +
        "NIST publishes the same k coefficients for 316 as for 304.  ANL-75-55 states the property " +
        "difference between 316 and 316L is negligible; above ~1200 K the ANL 316L correlations are the " +
        "report’s own extrapolation toward the melting range.  Capped at 1600 K; outside 4–1600 K the value " +
        "is clamped to the nearest end of the range.",
    },
  },
  "inconel-718": {
    cpTable: sampleComposite(
      [
        { f: in718CpLow, Tmin: 298, Tmax: 800 },
        { f: in718CpMid, Tmin: 800, Tmax: 900 },
        {
          f: linearBridge(900, in718CpMid(900), 1070, in718CpHigh(1070)),
          Tmin: 900,
          Tmax: 1070,
        },
        { f: in718CpHigh, Tmin: 1070, Tmax: 1375 },
      ],
      MATERIAL_SAMPLE_TOL,
    ),
    kTable: sampleComposite(
      [
        { f: in718KLow, Tmin: 298, Tmax: 800 },
        {
          f: linearBridge(800, in718KLow(800), 1173, in718KHigh(1173)),
          Tmin: 800,
          Tmax: 1173,
        },
        { f: in718KHigh, Tmin: 1173, Tmax: 1375 },
      ],
      MATERIAL_SAMPLE_TOL,
    ),
    provenance: {
      source:
        'A. Sh. Agazhanov, D. A. Samoshkin & Yu. M. Kozlovskii, "Thermophysical properties of Inconel 718 ' +
        'alloy", J. Phys.: Conf. Ser. 1382 (2019) 012175 (open access, CC-BY 3.0)',
      url: "https://doi.org/10.1088/1742-6596/1382/1/012175",
      fitForm:
        "cp [J/(g·K)]: 0.362 + 2.118e-4·T (298–800 K); −0.946 + 2.95e-3·T − 1.379e-6·T² (800–900 K); " +
        "0.639 − 3.355e-6·T (1070–1361 K, applied through 1375 K as in the paper’s Table 2).  " +
        "k [W/(m·K)]: 5.291 + 0.0152·T + 1.382e-6·T² (298–800 K); 11.75 + 0.011·T − 9.327e-7·T² (1173–1375 K).",
      validityRangeK: [298, 1375],
      statedFitAccuracy:
        "cp: 2–3 %; k: 3–5 % (per the source paper); correlation RMS deviations ≤0.5 % from the measured points",
      notes:
        "High-temperature range only (no credible low-T cp correlation is published for this catalogue); " +
        "below 298 K the value is clamped to the 298 K value.  The γ″/δ phase-transformation intervals " +
        "900–1070 K (cp) and 800–1173 K (k) have no single-phase correlation in the source; the catalogue " +
        "bridges them with a straight line between the two branch endpoints (documented approximation).  " +
        "Above 1375 K the value is clamped.",
    },
  },
  ptfe: {
    cpTable: sampleAdaptive(nistPtfeCpFit, 4, 300, MATERIAL_SAMPLE_TOL),
    kTable: sampleAdaptive(nistPtfeKFit, 4, 300, MATERIAL_SAMPLE_TOL),
    provenance: {
      source:
        'NIST Cryogenic Material Properties Database, "Teflon" (PTFE) ' +
        "(Marquardt, Le & Radebaugh 2000)",
      url: "https://trc.nist.gov/cryogenics/materials/Teflon/Teflon_rev.htm",
      fitForm: "cp and k: log10(y) = 8th-order polynomial in log10(T)",
      validityRangeK: [4, 300],
      statedFitAccuracy: "cp: 1.5 %; k: 5 % (per NIST database page)",
      notes:
        "Cryogenic range only: outside 4–300 K the value is clamped to the nearest end of the range. " +
        "Tables are adaptive samples of the fits (≤1e-3 relative interpolation error).",
    },
  },
  "g10-cr-normal": {
    cpTable: sampleAdaptive(nistG10CpFit, 4, 300, MATERIAL_SAMPLE_TOL),
    kTable: sampleAdaptive(nistG10KNormalFit, 10, 300, MATERIAL_SAMPLE_TOL),
    provenance: {
      source:
        'NIST Cryogenic Material Properties Database, "G-10 CR (Fiberglass Epoxy)" — NORMAL (through-thickness) ' +
        "direction k (Marquardt, Le & Radebaugh 2000)",
      url: "https://trc.nist.gov/cryogenics/materials/G-10%20CR%20Fiberglass%20Epoxy/G10CRFiberglassEpoxy_rev.htm",
      fitForm: "cp and k: log10(y) = 8th-order polynomial in log10(T)",
      validityRangeK: [10, 300],
      statedFitAccuracy: "cp: 2 %; k: 5 % (per NIST database page)",
      notes:
        "Anisotropic composite: this entry carries the NORMAL (through-thickness) thermal conductivity; " +
        "use g10-cr-warp for the in-plane (warp) direction.  cp equation range 4–300 K; k equation range " +
        "10–300 K.  Outside those ranges each value is clamped to the nearest end of its range.  " +
        "Tables are adaptive samples of the fits (≤1e-3 relative interpolation error).",
    },
  },
  "g10-cr-warp": {
    cpTable: sampleAdaptive(nistG10CpFit, 4, 300, MATERIAL_SAMPLE_TOL),
    kTable: sampleAdaptive(nistG10KWarpFit, 12, 300, MATERIAL_SAMPLE_TOL),
    provenance: {
      source:
        'NIST Cryogenic Material Properties Database, "G-10 CR (Fiberglass Epoxy)" — WARP (in-plane) ' +
        "direction k (Marquardt, Le & Radebaugh 2000)",
      url: "https://trc.nist.gov/cryogenics/materials/G-10%20CR%20Fiberglass%20Epoxy/G10CRFiberglassEpoxy_rev.htm",
      fitForm: "cp and k: log10(y) = 8th-order polynomial in log10(T)",
      validityRangeK: [12, 300],
      statedFitAccuracy: "cp: 2 %; k: 5 % (per NIST database page)",
      notes:
        "Anisotropic composite: this entry carries the WARP (in-plane) thermal conductivity; " +
        "use g10-cr-normal for the through-thickness direction.  cp equation range 4–300 K; k equation " +
        "range 12–300 K.  Outside those ranges each value is clamped to the nearest end of its range.  " +
        "Tables are adaptive samples of the fits (≤1e-3 relative interpolation error).",
    },
  },
};

/** Knots of a named material's property table (COPY — safe for callers to scale
 *  or mutate, e.g. a calibration cp-scale probe). */
export function getSolidMaterialTable(
  material: string,
  property: "cp" | "k",
): Array<[number, number]> {
  const m = SOLID_MATERIALS[material];
  if (!m) {
    throw new Error(
      `Unknown solid material "${material}". Known: ${Object.keys(SOLID_MATERIALS).join(", ")}`,
    );
  }
  const t = property === "cp" ? m.cpTable : m.kTable;
  if (!t)
    throw new Error(`Solid material "${material}" has no ${property} curve`);
  return t.map(([T, v]) => [T, v]);
}

// ---------------------------------------------------------------------------
// Spec shape classification (single dispatch order, shared by every consumer)
// ---------------------------------------------------------------------------

/** Canonical spec-shape precedence: number → table → material → expression →
 *  timeTable (first match wins; a pathological object carrying several keys
 *  resolves to the earliest shape, exactly as resolveSolidProperty has always
 *  done for `{table, material}`). */
export type SolidPropertyShape =
  "constant" | "table" | "material" | "expression" | "timeTable" | "unknown";

export function solidPropertyShape(
  spec: SolidPropertySpec | undefined,
): SolidPropertyShape {
  if (typeof spec === "number") return "constant";
  if (typeof spec === "object" && spec !== null) {
    if ("table" in spec) return "table";
    if ("material" in spec) return "material";
    if ("expression" in spec) return "expression";
    if ("timeTable" in spec) return "timeTable";
  }
  return "unknown";
}

/** True for the `{ expression, tRange }` (custom T equation) shape. */
export function isExpressionSpec(
  spec: SolidPropertySpec | undefined,
): spec is { expression: string; tRange: [number, number] } {
  return solidPropertyShape(spec) === "expression";
}

/** True for the `{ timeTable }` (time-varying) shape. */
export function isTimeTableSpec(
  spec: SolidPropertySpec | undefined,
): spec is { timeTable: Array<[number, number]> } {
  return solidPropertyShape(spec) === "timeTable";
}

// ---------------------------------------------------------------------------
// Custom temperature equations — `{ expression, tRange }`
// ---------------------------------------------------------------------------

/** Sampling tolerance for expression curves (same convention as the NIST
 *  fit sampling: ≤ 1e-3 relative deviation of the piecewise-linear chord). */
const EXPRESSION_SAMPLE_TOL = 1e-3;
/** Hard cap on sampled knots — guards against non-convergent sampling
 *  (poles, near-discontinuities) looping at float resolution. */
const EXPRESSION_MAX_KNOTS = 2049;

/**
 * Adaptive expression sampler: like sampleAdaptive, but evaluates through the
 * safe expression engine with per-point finite/positive enforcement, an
 * owner-named error on any failure, a knot cap, and a float-exhaustion guard
 * (a midpoint that no longer strictly subdivides is treated as converged —
 * the chord is exact at representable resolution).
 */
function sampleExpressionKnots(
  f: (T: number) => number,
  Tmin: number,
  Tmax: number,
  tol: number,
  cap: number,
  owner: string,
  property: "cp" | "k",
): Array<[number, number]> {
  const pts: Array<[number, number]> = [
    [Tmin, f(Tmin)],
    [Tmax, f(Tmax)],
  ];
  const stack: Array<[number, number]> = [[Tmin, Tmax]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const m = 0.5 * (a + b);
    if (!(m > a && m < b)) continue; // adjacent floats: chord is exact
    const fm = f(m);
    const lin = 0.5 * (f(a) + f(b));
    if (Math.abs(fm - lin) > tol * Math.abs(fm)) {
      pts.push([m, fm]);
      if (pts.length > cap) {
        throw new Error(
          `${owner}: ${property} expression could not be sampled to ${tol} relative ` +
            `tolerance within ${cap} knots (pole or discontinuity inside tRange?)`,
        );
      }
      stack.push([a, m], [m, b]);
    }
  }
  pts.sort((x, y) => x[0] - y[0]);
  return pts;
}

/**
 * Sample an `{ expression, tRange }` spec into the canonical
 * PiecewiseLinearProperty (T-domain).  The expression is compiled with the
 * SAFE expression engine (no eval) and evaluated with scope `{ T }` plus the
 * builtins.  Throws an owner-named Error on: empty/unparseable source, a
 * missing/invalid tRange (must be [Tmin, Tmax] finite, positive, increasing),
 * or any sampled value that is not finite and positive (the adaptive sampler
 * probes the whole range, so poles/negative regions inside tRange are
 * caught here — at context build / validation time, never mid-solve).
 */
export function sampleExpressionProperty(
  spec: { expression: string; tRange: [number, number] },
  property: "cp" | "k",
  owner: string,
): PiecewiseLinearProperty {
  const errs = validateExpressionSpecShape(spec, property, owner);
  if (errs.length > 0) throw new Error(errs.join("; "));
  let compiled: ReturnType<typeof compileExpression>;
  try {
    compiled = compileExpression(spec.expression);
  } catch (e) {
    // Unreachable after validateExpressionSpecShape; kept as defense.
    throw new Error(
      `${owner}: ${property} expression failed to parse: ${e instanceof ExpressionError ? e.message : String(e)}`,
    );
  }
  const f = (T: number): number => {
    let v: number;
    try {
      v = compiled.evaluateNumber({ T });
    } catch (e) {
      throw new Error(
        `${owner}: ${property} expression failed to evaluate at T=${T} K: ${e instanceof ExpressionError ? e.message : String(e)}`,
      );
    }
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(
        `${owner}: ${property} expression must be finite and positive over tRange ` +
          `(got ${v} at T=${T} K)`,
      );
    }
    return v;
  };
  const [Tmin, Tmax] = spec.tRange;
  const knots = sampleExpressionKnots(
    f,
    Tmin,
    Tmax,
    EXPRESSION_SAMPLE_TOL,
    EXPRESSION_MAX_KNOTS,
    owner,
    property,
  );
  return new PiecewiseLinearProperty(knots);
}

/** Structural checks for the `{ expression, tRange }` shape (no sampling). */
function validateExpressionSpecShape(
  spec: { expression: string; tRange: [number, number] },
  property: "cp" | "k",
  owner: string,
): string[] {
  const errs: string[] = [];
  const source: unknown = spec.expression;
  if (typeof source !== "string" || source.trim().length === 0) {
    errs.push(
      `${owner}: ${property} expression must be a non-empty expression string`,
    );
    return errs;
  }
  try {
    compileExpression(source);
  } catch (e) {
    errs.push(
      `${owner}: ${property} expression failed to parse: ${e instanceof ExpressionError ? e.message : String(e)}`,
    );
    return errs;
  }
  const range: unknown = spec.tRange;
  if (!Array.isArray(range) || range.length !== 2) {
    errs.push(
      `${owner}: ${property} expression requires tRange: [Tmin, Tmax] (K)`,
    );
    return errs;
  }
  const [lo, hi] = range as unknown[];
  if (typeof lo !== "number" || !Number.isFinite(lo) || lo <= 0) {
    errs.push(
      `${owner}: ${property} tRange lower bound must be a positive finite temperature in K (got ${String(lo)})`,
    );
  } else if (typeof hi !== "number" || !Number.isFinite(hi) || hi <= lo) {
    errs.push(
      `${owner}: ${property} tRange must be increasing (got [${String(lo)}, ${String(hi)}])`,
    );
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Time-varying properties — `{ timeTable }`
// ---------------------------------------------------------------------------

/**
 * Validate a `{ timeTable }` curve: x = time [s] — finite, ≥ 0, strictly
 * increasing; values finite and > 0.  Mirrors validateTable with the time
 * domain.  (Transient-mode-only enforcement lives in validate.ts, which knows
 * the solve mode; this layer is mode-agnostic.)
 */
function validateTimeTable(
  table: Array<[number, number]>,
  property: "cp" | "k",
  owner: string,
): string[] {
  const errs: string[] = [];
  if (!Array.isArray(table) || table.length < 2) {
    errs.push(
      `${owner}: ${property} timeTable needs at least 2 [t, value] points`,
    );
    return errs;
  }
  for (let i = 0; i < table.length; i++) {
    const [t, v] = table[i];
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0) {
      errs.push(
        `${owner}: ${property} timeTable times must be non-negative finite seconds (point ${i}: t=${t})`,
      );
      break;
    }
    if (!(v > 0) || !Number.isFinite(v)) {
      errs.push(
        `${owner}: ${property} timeTable values must be positive finite (point ${i}: value=${v})`,
      );
      break;
    }
    if (i > 0 && !(t > table[i - 1][0])) {
      errs.push(
        `${owner}: ${property} timeTable times must be strictly increasing (point ${i})`,
      );
      break;
    }
  }
  return errs;
}

/**
 * Resolve a `{ timeTable }` spec to a TIME-domain PiecewiseLinearProperty
 * (clamped at the end knots, like schedules).  Returns undefined for every
 * other shape so callers can dispatch
 * (`const tc = resolveSolidTimeProperty(...); if (tc) … else …existing…`).
 * Throws owner-named errors on malformed time tables (validate.ts reports
 * these as config errors first).
 */
export function resolveSolidTimeProperty(
  spec: SolidPropertySpec,
  property: "cp" | "k",
  owner: string,
): PiecewiseLinearProperty | undefined {
  if (!isTimeTableSpec(spec)) return undefined;
  const errs = validateTimeTable(spec.timeTable, property, owner);
  if (errs.length > 0) throw new Error(errs.join("; "));
  return new PiecewiseLinearProperty(spec.timeTable);
}

// ---------------------------------------------------------------------------
// Resolution & validation
// ---------------------------------------------------------------------------

/**
 * Resolve a spec to either a constant number (legacy path — callers must keep
 * their existing constant handling) or a PiecewiseLinearProperty.
 * Throws on malformed specs (validate.ts reports these as config errors; the
 * solver defends itself because solveTransient does not run validateNetwork).
 *
 * T-DOMAIN ONLY: `{ timeTable }` is time-varying and deliberately NOT
 * resolvable here — resolve it with resolveSolidTimeProperty so the time
 * curve can never be mistaken for a T curve.
 */
export function resolveSolidProperty(
  spec: SolidPropertySpec,
  property: "cp" | "k",
  owner: string,
): number | PiecewiseLinearProperty {
  if (typeof spec === "number") return spec;
  if ("table" in spec) {
    const errs = validateTable(spec.table, property, owner);
    if (errs.length > 0) throw new Error(errs.join("; "));
    return new PiecewiseLinearProperty(spec.table);
  }
  if ("material" in spec) {
    return new PiecewiseLinearProperty(
      getSolidMaterialTable(spec.material, property),
    );
  }
  if ("expression" in spec) {
    return sampleExpressionProperty(spec, property, owner);
  }
  if ("timeTable" in spec) {
    throw new Error(
      `${owner}: ${property} timeTable is time-varying; resolve it with resolveSolidTimeProperty`,
    );
  }
  throw new Error(`${owner}: unrecognized ${property} specification`);
}

function validateTable(
  table: Array<[number, number]>,
  property: "cp" | "k",
  owner: string,
): string[] {
  const errs: string[] = [];
  if (!Array.isArray(table) || table.length < 2) {
    errs.push(`${owner}: ${property} table needs at least 2 [T, value] points`);
    return errs;
  }
  for (let i = 0; i < table.length; i++) {
    const [T, v] = table[i];
    if (!(T > 0) || !Number.isFinite(T)) {
      errs.push(
        `${owner}: ${property} table temperatures must be positive finite K (point ${i}: T=${T})`,
      );
      break;
    }
    if (!(v > 0) || !Number.isFinite(v)) {
      errs.push(
        `${owner}: ${property} table values must be positive finite (point ${i}: value=${v})`,
      );
      break;
    }
    if (i > 0 && !(T > table[i - 1][0])) {
      errs.push(
        `${owner}: ${property} table temperatures must be strictly increasing (point ${i})`,
      );
      break;
    }
  }
  return errs;
}

/** Config-validation entry point (used by validate.ts).  Returns error strings.
 *  Mode-aware rules (timeTable needs transient mode) live in validate.ts,
 *  which knows settings.mode. */
export function validateSolidPropertySpec(
  spec: SolidPropertySpec | undefined,
  property: "cp" | "k",
  owner: string,
): string[] {
  if (spec === undefined) return [`${owner}: ${property} is required`];
  if (typeof spec === "number") {
    return spec > 0 && Number.isFinite(spec)
      ? []
      : [`${owner}: ${property} must be positive`];
  }
  if (typeof spec === "object" && spec !== null && "table" in spec) {
    return validateTable(spec.table, property, owner);
  }
  if (typeof spec === "object" && spec !== null && "material" in spec) {
    const m = SOLID_MATERIALS[spec.material];
    if (!m) {
      return [
        `${owner}: unknown solid material "${spec.material}". Known: ${Object.keys(SOLID_MATERIALS).join(", ")}`,
      ];
    }
    if (property === "k" && !m.kTable) {
      return [`${owner}: material "${spec.material}" has no k curve`];
    }
    return [];
  }
  if (typeof spec === "object" && spec !== null && "expression" in spec) {
    const errs = validateExpressionSpecShape(spec, property, owner);
    if (errs.length > 0) return errs;
    // Sampling check: the compiled expression must evaluate finite and
    // positive across the whole tRange (the adaptive sampler probes it).
    try {
      sampleExpressionProperty(spec, property, owner);
    } catch (e) {
      return [e instanceof Error ? e.message : String(e)];
    }
    return [];
  }
  if (typeof spec === "object" && spec !== null && "timeTable" in spec) {
    return validateTimeTable(spec.timeTable, property, owner);
  }
  return [`${owner}: malformed ${property} specification`];
}
