/**
 * Closed-form derivativesPH of the analytic fluid models vs central finite
 * differences of their own statePH.  These partials feed the coupled-h
 * Newton system's dual-number Jacobian, so an error here shows up as a
 * wrong search direction, not a wrong answer — exactly the kind of bug that
 * converges slowly instead of failing loudly.
 */
import { describe, it, expect } from "vitest";
import { IncompressibleLiquid, IdealGas, ExpandableLiquid } from "../fluids";
import type { FluidModel } from "../fluids";

function fdPartials(fluid: FluidModel, P: number, h: number) {
  const dP = Math.max(Math.abs(P) * 1e-6, 1e-2);
  const dh = Math.max(Math.abs(h) * 1e-6, 1e-2);
  const pp = fluid.statePH(P + dP, h);
  const pm = fluid.statePH(P - dP, h);
  const hp = fluid.statePH(P, h + dh);
  const hm = fluid.statePH(P, h - dh);
  return {
    drhodP_h: (pp.rho - pm.rho) / (2 * dP),
    drhodh_P: (hp.rho - hm.rho) / (2 * dh),
    dTdP_h: (pp.T - pm.T) / (2 * dP),
    dTdh_P: (hp.T - hm.T) / (2 * dh),
  };
}

const CASES: Array<[string, FluidModel, number, number]> = [
  ["IncompressibleLiquid (water)", IncompressibleLiquid.WATER, 3e5, 4182 * 300],
  ["IdealGas (air, warm)", IdealGas.AIR, 1e5, 1005 * 300],
  ["IdealGas (air, hot high-P)", IdealGas.AIR, 2e6, 1005 * 3000],
  [
    "IdealGas (custom combustion gas)",
    new IdealGas(346, 1.22, 8.5e-5, 1900),
    6.9e6,
    1900 * 3500,
  ],
  [
    "ExpandableLiquid (water)",
    ExpandableLiquid.WATER_EXPANDABLE,
    5e5,
    4182 * 350,
  ],
];

describe("analytic derivativesPH matches central FD of statePH", () => {
  it.each(CASES)("%s", (_label, fluid, P, h) => {
    const der = fluid.derivativesPH!(P, h);
    const fd = fdPartials(fluid, P, h);
    for (const key of ["drhodP_h", "drhodh_P", "dTdP_h", "dTdh_P"] as const) {
      const scale = Math.max(Math.abs(fd[key]), 1e-12);
      expect(Math.abs(der[key] - fd[key]) / scale).toBeLessThan(1e-4);
    }
  });

  it("agrees with the branch statePH takes (phase consistency)", () => {
    for (const [, fluid, P, h] of CASES) {
      expect(fluid.derivativesPH!(P, h).phase).toBe(fluid.statePH(P, h).phase);
    }
  });
});
