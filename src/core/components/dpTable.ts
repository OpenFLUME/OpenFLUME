import type { BranchComponent } from "./branchComponent";

/** Tabulated ΔP(ṁ) characteristic.
 *
 *  `points` are [mdot, dP] pairs (kg/s, Pa) with mdot STRICTLY increasing
 *  (enforced by validate.ts).  Inside the tabulated range the curve is
 *  piecewise linear.
 *
 *  Extrapolation beyond the tabulated range:
 *    'clamp' (default): hold the endpoint dP value;
 *    'linear': extend the end segment's slope.
 *
 *  Reverse flow: if ALL tabulated mdot points are >= 0 the curve is mirrored
 *  oddly — dp(-m) = -dp(m) — with an implicit linear segment from the origin
 *  to the first breakpoint when the first breakpoint is at mdot > 0 (so the
 *  extended curve passes through (0,0) and is C0 at the origin).  Tables
 *  that already contain negative-mdot points are used as-is over their
 *  range (no mirroring) and clamped/extended per `extrapolate`.
 *
 *  Scalar-only: no pressureDropDual (piecewise-linear corners are handled by
 *  the solver's FD Jacobian fallback).
 */
export class DpTable implements BranchComponent {
  readonly points: Array<[number, number]>;
  readonly extrapolate: "clamp" | "linear";
  readonly area = 1;
  readonly elevationChange = 0;
  /** True when the table is forward-only (all mdot >= 0) and reverse flow
   *  uses the odd mirror dp(-m) = -dp(m). */
  private readonly mirrored: boolean;

  constructor(
    points: Array<[number, number]>,
    extrapolate: "clamp" | "linear" = "clamp",
  ) {
    this.points = points
      .map(([m, d]) => [m, d] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    this.extrapolate = extrapolate;
    this.mirrored =
      this.points.length > 0 && this.points.every(([m]) => m >= 0);
  }

  /** Forward-branch evaluation for mdot >= 0 (mirrored tables). */
  private evalForward(mdot: number): number {
    const c = this.points;
    if (c.length === 0) return 0;
    if (c.length === 1) {
      // Degenerate single point: linear through origin, or clamped constant.
      if (c[0][0] > 0) return (c[0][1] / c[0][0]) * mdot;
      return c[0][1];
    }
    if (mdot <= c[0][0]) {
      if (c[0][0] > 0) {
        // Implicit anchor at the origin for the odd extension.
        return (c[0][1] / c[0][0]) * mdot;
      }
      return c[0][1];
    }
    if (mdot >= c[c.length - 1][0]) {
      const [m1, d1] = c[c.length - 1];
      if (this.extrapolate === "clamp") return d1;
      const [m0, d0] = c[c.length - 2];
      const slope = m1 === m0 ? 0 : (d1 - d0) / (m1 - m0);
      return d1 + slope * (mdot - m1);
    }
    for (let i = 0; i < c.length - 1; i++) {
      if (mdot >= c[i][0] && mdot <= c[i + 1][0]) {
        const dm = c[i + 1][0] - c[i][0];
        if (dm === 0) return c[i][1];
        const frac = (mdot - c[i][0]) / dm;
        return c[i][1] + frac * (c[i + 1][1] - c[i][1]);
      }
    }
    return c[c.length - 1][1];
  }

  /** As-tabulated evaluation (tables that include negative mdot points). */
  private evalRanged(mdot: number): number {
    const c = this.points;
    if (c.length === 0) return 0;
    if (c.length === 1) return c[0][1];
    if (mdot <= c[0][0]) {
      if (this.extrapolate === "clamp") return c[0][1];
      const slope =
        c[1][0] === c[0][0] ? 0 : (c[1][1] - c[0][1]) / (c[1][0] - c[0][0]);
      return c[0][1] + slope * (mdot - c[0][0]);
    }
    if (mdot >= c[c.length - 1][0]) {
      const n = c.length;
      if (this.extrapolate === "clamp") return c[n - 1][1];
      const slope =
        c[n - 1][0] === c[n - 2][0]
          ? 0
          : (c[n - 1][1] - c[n - 2][1]) / (c[n - 1][0] - c[n - 2][0]);
      return c[n - 1][1] + slope * (mdot - c[n - 1][0]);
    }
    for (let i = 0; i < c.length - 1; i++) {
      if (mdot >= c[i][0] && mdot <= c[i + 1][0]) {
        const dm = c[i + 1][0] - c[i][0];
        if (dm === 0) return c[i][1];
        const frac = (mdot - c[i][0]) / dm;
        return c[i][1] + frac * (c[i + 1][1] - c[i][1]);
      }
    }
    return c[c.length - 1][1];
  }

  pressureDrop(mdot: number, _rho?: number, _mu?: number, _t?: number): number {
    if (this.mirrored) {
      return mdot >= 0 ? this.evalForward(mdot) : -this.evalForward(-mdot);
    }
    return this.evalRanged(mdot);
  }
}
