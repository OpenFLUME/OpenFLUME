/**
 * Darcy friction factor (Hagen–Poiseuille / Swamee–Jain, smoothly blended)
 * used by Pipe and Bend, plus the generic `smoothstep` blend also used by
 * ReliefValve.
 */
import {
  DEFAULT_CLOSURE_PARAMS,
  type SwameeJainClosureParams,
} from "../closureParams";
import type { Dual } from "../dual";
import { constant, add, sub, mul, div, pow, log10, max, sqr } from "../dual";

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Laminar cutoff Reynolds number — also the lower edge of the transition blend. */
export const RE_LAMINAR = 2300;
/** Turbulent onset Reynolds number — the upper edge of the transition blend. */
export const RE_TURBULENT = 4000;

/** Swamee–Jain explicit approximation of the Colebrook equation (Darcy f).
 *  The four published constants are calibratable closure parameters
 *  (defaults = published values, bit-identical — see closureParams.ts). */
function swameeJain(
  Re: number,
  epsOverD: number,
  sj: SwameeJainClosureParams = DEFAULT_CLOSURE_PARAMS.swameeJain,
): number {
  const rhs =
    epsOverD / sj.roughnessDivisor +
    sj.reynoldsCoefficient / Math.pow(Re, sj.reynoldsExponent);
  return sj.leadingCoefficient / Math.pow(Math.log10(rhs), 2);
}

/** Darcy friction factor, C0- and C1-continuous across the entire Re range.
 *    Re < RE_LAMINAR:  f = 64/Re (Hagen–Poiseuille, exact — do not alter the 64)
 *    Re ≥ RE_TURBULENT: Swamee–Jain
 *    between: smoothstep blend of 64/Re and Swamee–Jain, BOTH evaluated at the
 *    actual Re.  The smoothstep weight has zero slope at both endpoints, so the
 *    blend matches the value AND the derivative of each branch at its edge.
 *  (Historically the blend was anchored at the constant flam = 64/2300, which
 *  produced a ~13 % jump in f at Re = 2000; the laminar cutoff and the blend
 *  lower edge are now the same number, RE_LAMINAR.)
 */
export function darcyFrictionFactor(
  Re: number,
  epsOverD: number,
  sj: SwameeJainClosureParams = DEFAULT_CLOSURE_PARAMS.swameeJain,
): number {
  // Re = NaN arises at mdot = 0 with a zero-viscosity fluid (0/0; see the
  // mu ≡ 0 note on the dual twin below): return the same fully-rough
  // constant the dual path uses — the caller multiplies by zero flow anyway,
  // and a NaN here poisoned the whole momentum row.
  if (!Number.isFinite(Re)) return swameeJain(Infinity, epsOverD, sj);
  if (Re < RE_LAMINAR) return 64 / Math.max(Re, 1e-6);
  const fturb = swameeJain(Re, epsOverD, sj);
  if (Re >= RE_TURBULENT) return fturb;
  const flam = 64 / Re;
  const s = smoothstep(RE_LAMINAR, RE_TURBULENT, Re);
  return flam * (1 - s) + fturb * s;
}

/** Dual-number twin of darcyFrictionFactor — identical branching on the primal
 *  so value and derivative stay consistent with the scalar path.  In the blend
 *  both flam(Re) and fturb(Re) are Re-dependent duals, so the derivative is
 *  correct through the transition region. */
export function darcyFrictionFactorDual(
  Re: Dual,
  epsOverD: number,
  sj: SwameeJainClosureParams = DEFAULT_CLOSURE_PARAMS.swameeJain,
): Dual {
  // Re = ±∞ arises when the viscosity model returns exactly 0 (NitrousOxide's
  // HEOS backend ships no viscosity model — safeViscosity pins mu ≡ 0): the
  // dual div guard then yields Re.v = ±∞ with Re.d = 0.  The scalar path
  // evaluates swameeJain(∞) = 0.25/log10(ε/3.7D)² — the fully-rough limit,
  // constant in Re — so the consistent dual is that constant with d = 0.
  // (Letting the ∞ flow through pow/log10 turns 0·∞ into NaN downstream, which
  // poisoned every Pipe/Bend momentum row for NitrousOxide networks.)
  if (!Number.isFinite(Re.v))
    return constant(swameeJain(Infinity, epsOverD, sj));
  if (Re.v < RE_LAMINAR) {
    return div(constant(64), max(Re, constant(1e-6)));
  }
  const rhs = add(
    constant(epsOverD / sj.roughnessDivisor),
    div(
      constant(sj.reynoldsCoefficient),
      pow(Re, constant(sj.reynoldsExponent)),
    ),
  );
  const fturb = div(constant(sj.leadingCoefficient), sqr(log10(rhs)));
  if (Re.v >= RE_TURBULENT) return fturb;
  // smoothstep s = t²(3 − 2t) with t = (Re − RE_LAMINAR)/(RE_TURBULENT − RE_LAMINAR)
  const t = div(
    sub(Re, constant(RE_LAMINAR)),
    constant(RE_TURBULENT - RE_LAMINAR),
  );
  const s = mul(sqr(t), sub(constant(3), mul(constant(2), t)));
  const flam = div(constant(64), Re);
  return add(mul(flam, sub(constant(1), s)), mul(fturb, s));
}
