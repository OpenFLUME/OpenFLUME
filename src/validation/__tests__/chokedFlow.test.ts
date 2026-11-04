/**
 * Choked cryogenic flow through nozzles and a sharp-edged orifice against
 * NASA TP-1484 and TM X-71760 measurements (scientific tier — excluded from
 * the fast PR gate in vitest.fast.config.ts, run by `npm run test:all`).
 *
 * Cases, QC and models are defined once in src/validation/chokedFlow.ts and
 * rendered by scripts/choked-flow-validation-report.ts.  The bands below are
 * regression sentinels around the measured agreement (median and range of
 * G_model/G_measured per inlet regime), not accuracy claims; the two
 * regimes where a closure is known to be inapplicable (near-saturated
 * liquid, dense supercritical inlets through the expansibility closure) are
 * pinned as documented disagreements so that a change in either direction
 * is noticed.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initRealFluids } from "../../core";
import {
  INLET_REGIMES,
  hemCriticalFlux,
  nozzlePoints,
  orificePoints,
  predict,
  ratioStats,
  type ChokedFlowResult,
} from "../chokedFlow";

let nozzle: ChokedFlowResult[] = [];
let orificeAtPb: ChokedFlowResult[] = [];
let orificeChoked: ChokedFlowResult[] = [];

beforeAll(async () => {
  await initRealFluids();
  nozzle = nozzlePoints()
    .filter((p) => p.usable)
    .map((p) => predict(p));
  const ori = orificePoints().filter((p) => p.usable);
  orificeAtPb = ori.map((p) => predict(p, "orifice at measured Pb"));
  orificeChoked = ori.map((p) => predict(p));
}, 120000);

const stats = (rs: ChokedFlowResult[], regime: string) =>
  ratioStats(
    rs.filter((r) => r.regime === regime).map((r) => r.Gmodel / r.point.G),
  )!;

describe("transcription QC", () => {
  it("keeps the expected number of usable rows", () => {
    const n = nozzlePoints();
    const o = orificePoints();
    expect(n).toHaveLength(447);
    expect(n.filter((p) => p.usable)).toHaveLength(326);
    expect(o).toHaveLength(109);
    expect(o.filter((p) => p.usable)).toHaveLength(26);
    for (const p of [...n, ...o])
      expect(p.usable).toBe(p.excluded.length === 0);
  });
});

describe("HEM reference", () => {
  it("reduces to the ideal-gas critical flux for nitrogen gas at 300 K", () => {
    const P0 = 5e5;
    const T0 = 300;
    const R = 8.314462618 / 0.0280134;
    const g = 1.4;
    const ideal =
      P0 *
      Math.sqrt(g / (R * T0)) *
      Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
    const hem = hemCriticalFlux("Nitrogen", P0, T0);
    expect(Math.abs(hem.G - ideal) / ideal).toBeLessThan(0.005);
    expect(Math.abs(hem.Pstar / P0 - 0.5283)).toBeLessThan(0.005);
  });
});

describe("nozzles (TP-1484): primary closures", () => {
  it("every solve converges", () => {
    expect(nozzle.length).toBe(326);
    expect(nozzle.every((r) => r.converged)).toBe(true);
  });

  it("subcooled liquid: choked-liquid venturi closure within +4.5 % median", () => {
    const s = stats(nozzle, INLET_REGIMES[0]);
    expect(s.n).toBe(115);
    expect(s.median).toBeGreaterThan(1.02);
    expect(s.median).toBeLessThan(1.07);
    expect(s.min).toBeGreaterThan(0.95);
    expect(s.max).toBeLessThan(1.2);
  });

  it("near-saturated liquid: under-predicts (documented non-equilibrium disagreement)", () => {
    const s = stats(nozzle, INLET_REGIMES[1]);
    expect(s.n).toBe(124);
    expect(s.median).toBeGreaterThan(0.84);
    expect(s.median).toBeLessThan(0.92);
    expect(s.min).toBeLessThan(0.5);
  });

  it("supercritical: expansibility closure over-predicts (documented disagreement)", () => {
    const s = stats(nozzle, INLET_REGIMES[2]);
    expect(s.n).toBe(81);
    expect(s.median).toBeGreaterThan(1.25);
    expect(s.median).toBeLessThan(1.36);
    expect(s.min).toBeGreaterThan(1.05);
  });

  it("gas: expansibility closure within 6 %", () => {
    const s = stats(nozzle, INLET_REGIMES[3]);
    expect(s.n).toBe(6);
    expect(s.min).toBeGreaterThan(0.94);
    expect(s.max).toBeLessThan(1.06);
  });

  it("HEM reference agrees with supercritical and gaseous data within 4 % median", () => {
    for (const reg of [INLET_REGIMES[2], INLET_REGIMES[3]]) {
      const h = ratioStats(
        nozzle.filter((r) => r.regime === reg).map((r) => r.Ghem / r.point.G),
      )!;
      expect(Math.abs(h.median - 1)).toBeLessThan(0.04);
    }
  });
});

describe("sharp-edged orifice (TM X-71760), C_d = 0.61", () => {
  it("orifice closure at the measured back pressure: −7 % to +3 % for subcooled inlets", () => {
    expect(orificeAtPb.every((r) => r.converged)).toBe(true);
    const s = stats(orificeAtPb, INLET_REGIMES[0]);
    expect(s.n).toBe(13);
    expect(s.min).toBeGreaterThan(0.93);
    expect(s.max).toBeLessThan(1.03);
  });

  it("choked-liquid closure under-predicts: the jet does not flash at Pv inside the orifice", () => {
    const sub = stats(orificeChoked, INLET_REGIMES[0]);
    const sat = stats(orificeChoked, INLET_REGIMES[1]);
    expect(sub.median).toBeLessThan(0.92);
    expect(sat.median).toBeLessThan(0.7);
  });
});
