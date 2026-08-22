import {
  DEFAULT_CLOSURE_PARAMS,
  type DittusBoelterClosureParams,
} from "../closureParams";

/** Dittus–Boelter: Nu = C·Re^m·Pr^n (heating exponent n = 0.4 by default; the
 *  constants are the calibratable closure parameters — see closureParams.ts).
 *  Below Re = 2000, laminar Nu = 3.66; above 4000, fully turbulent; smooth
 *  linear blend across 2000 → 4000 (regime-boundary numerics — deliberately
 *  NOT calibratable). */
export function dittusBoelterH(
  G: number,
  D: number,
  mu: number,
  k: number,
  cp: number,
  p: DittusBoelterClosureParams = DEFAULT_CLOSURE_PARAMS.dittusBoelter,
): number {
  const Re = (G * D) / mu;
  const Pr = (cp * mu) / k;
  const ReTurb = Math.max(Re, 1e-6);
  const NuTurb =
    p.leadingCoefficient *
    Math.pow(ReTurb, p.reynoldsExponent) *
    Math.pow(Pr, p.prandtlExponent);

  const NuLam = 3.66;
  let Nu: number;
  if (Re < 2000) {
    Nu = NuLam;
  } else if (Re >= 4000) {
    Nu = NuTurb;
  } else {
    const t = (Re - 2000) / 2000;
    Nu = NuLam * (1 - t) + NuTurb * t;
  }
  return (Nu * k) / D;
}
