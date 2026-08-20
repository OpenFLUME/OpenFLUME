import type { BranchComponent } from "./branchComponent";

/** Pump: pressure rise vs volumetric flow. Negative pressure drop (i.e., rise) in from→to direction. */
export class Pump implements BranchComponent {
  readonly curve: Array<[number, number]>;
  readonly area = 1;
  readonly elevationChange = 0;

  constructor(curve: Array<[number, number]>) {
    this.curve = curve;
  }

  private interpolate(Q: number): number {
    const c = this.curve;
    if (c.length === 0) return 0;
    if (c.length === 1) return c[0][1];
    if (Q <= c[0][0]) {
      const slope = (c[1][1] - c[0][1]) / (c[1][0] - c[0][0]);
      return c[0][1] + slope * (Q - c[0][0]);
    }
    if (Q >= c[c.length - 1][0]) {
      const slope =
        (c[c.length - 1][1] - c[c.length - 2][1]) /
        (c[c.length - 1][0] - c[c.length - 2][0]);
      return c[c.length - 1][1] + slope * (Q - c[c.length - 1][0]);
    }
    for (let i = 0; i < c.length - 1; i++) {
      if (Q >= c[i][0] && Q <= c[i + 1][0]) {
        const dx = c[i + 1][0] - c[i][0];
        if (dx === 0) return c[i][1];
        const frac = (Q - c[i][0]) / dx;
        return c[i][1] + frac * (c[i + 1][1] - c[i][1]);
      }
    }
    return c[c.length - 1][1];
  }

  pressureDrop(mdot: number, rho: number, _mu?: number, _t?: number): number {
    const Q = mdot / rho;
    const rise = this.interpolate(Q);
    return -rise;
  }
}
