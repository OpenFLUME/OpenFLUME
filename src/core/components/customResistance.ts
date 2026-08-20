import type { BranchComponent } from "./branchComponent";
import type { Dual } from "../dual";
import { constant, add, sub, mul, div, abs, toDual } from "../dual";

/** Custom K-factor resistance: constant K or a Reynolds-dependent K(Re) table.
 *
 *  ΔP = K · mdot·|mdot| / (2 ρ A²),  K from `k`:
 *    number           — constant (identical to FlowResistance);
 *    { kTable }       — piecewise-linear K(Re) on [Re, K] breakpoints with Re
 *                       strictly increasing; K is CLAMPED to the endpoint
 *                       values outside the tabulated Re range.
 *  Re = ρ·|v|·D/μ with v = mdot/(ρ·A); `diameter` is required when kTable is
 *  used.  With μ = 0 Re is taken as +∞ (fully-turbulent endpoint K).
 */
export class CustomResistance implements BranchComponent {
  readonly k: number | { kTable: Array<[number, number]> };
  readonly area: number;
  readonly diameter?: number;
  readonly elevationChange = 0;

  constructor(
    k: number | { kTable: Array<[number, number]> },
    area: number,
    diameter?: number,
  ) {
    this.k = k;
    this.area = area;
    this.diameter = diameter;
  }

  /** Tabulated K at a scalar Re, clamped to the endpoints.  Only meaningful
   *  when `k` is a { kTable } spec. */
  kAtRe(Re: number): number {
    const table = (this.k as { kTable: Array<[number, number]> }).kTable;
    if (Re <= table[0][0]) return table[0][1];
    if (Re >= table[table.length - 1][0]) return table[table.length - 1][1];
    for (let i = 0; i < table.length - 1; i++) {
      if (Re >= table[i][0] && Re <= table[i + 1][0]) {
        const dx = table[i + 1][0] - table[i][0];
        if (dx === 0) return table[i][1];
        const frac = (Re - table[i][0]) / dx;
        return table[i][1] + frac * (table[i + 1][1] - table[i][1]);
      }
    }
    return table[table.length - 1][1];
  }

  /** Local piecewise-linear slope dK/dRe at Re (0 outside the range). */
  private kSlopeAtRe(Re: number): number {
    const table = (this.k as { kTable: Array<[number, number]> }).kTable;
    if (Re <= table[0][0] || Re >= table[table.length - 1][0]) return 0;
    for (let i = 0; i < table.length - 1; i++) {
      if (Re >= table[i][0] && Re <= table[i + 1][0]) {
        const dx = table[i + 1][0] - table[i][0];
        if (dx === 0) return 0;
        return (table[i + 1][1] - table[i][1]) / dx;
      }
    }
    return 0;
  }

  private reynolds(mdot: number, rho: number, mu: number): number {
    const D = this.diameter as number;
    const v = mdot / (rho * this.area);
    if (mu <= 0) return Infinity;
    return (rho * Math.abs(v) * D) / mu;
  }

  pressureDrop(mdot: number, rho: number, mu: number, _t?: number): number {
    let K: number;
    if (typeof this.k === "number") {
      K = this.k;
    } else {
      K = this.kAtRe(this.reynolds(mdot, rho, mu));
    }
    return (K * mdot * Math.abs(mdot)) / (2 * rho * this.area * this.area);
  }

  pressureDropDual(
    mdot: Dual,
    rho: number | Dual,
    mu: number | Dual,
    _t?: number,
  ): Dual {
    const A = this.area;
    const rhoD = toDual(rho);
    let kDual: Dual;
    if (typeof this.k === "number") {
      kDual = constant(this.k);
    } else {
      const D = this.diameter as number;
      const muD = toDual(mu);
      const v = div(mdot, mul(rhoD, A));
      const Re = div(mul(mul(rhoD, D), abs(v)), muD);
      if (!Number.isFinite(Re.v)) {
        // mu = 0 limit: fully-turbulent endpoint K, constant in Re.
        kDual = constant(this.kAtRe(Infinity));
      } else {
        // Piecewise-linear K(Re): exact dual via the local slope segment.
        const Kv = this.kAtRe(Re.v);
        const dKdRe = this.kSlopeAtRe(Re.v);
        kDual = add(
          constant(Kv),
          mul(constant(dKdRe), sub(Re, constant(Re.v))),
        );
      }
    }
    return div(mul(kDual, mul(mdot, abs(mdot))), mul(rhoD, 2 * A * A));
  }
}
