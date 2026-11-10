/**
 * MRS radiator case (docs/validation/mrs-protocol.md): data and registry
 * integrity, builder size and bookkeeping, the convection expression against
 * an independent implementation, the energy and mass closure of a panel, and
 * the agreement of one tube with the independent hand calculation
 * (scripts/reference/mrs_hand_calc.py).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { initRealFluids } from "../../core/fluids/coolprop";
import { compileExpression } from "../../core/usercode/expression";
import {
  LBHR_TO_KGS,
  MRS_CLOSURE_LIMIT,
  MRS_GEOMETRY,
  MRS_R21_TRANSPORT,
  buildMrsPanelNetwork,
  mrsConvectionExpression,
  solveMrsLegChained,
  tubeFractions,
} from "../mrsRadiator";
import {
  errorStats,
  parseCsv,
  parseCsvRecords,
  readPanelOutlets,
  readRegistry,
} from "../mrsData";

const DATA = join(process.cwd(), "validation", "data", "digitized", "mrs");
const read = (f: string): string => readFileSync(join(DATA, f), "utf8");
const registry = readRegistry(read("mrs_test_point_registry.csv"));
const outlets = readPanelOutlets(read("mrs_panel_outlets_figs15_33.csv"));
const table = parseCsvRecords(read("mrs_r21_transport_table.csv")).map((r) => ({
  T_K: Number(r.T_K),
  mu: Number(r.mu_Pa_s),
  k: Number(r.k_W_mK),
}));

describe("MRS data and registry (pre-registered protocol)", () => {
  it("parses quoted CSV fields", () => {
    expect(parseCsv('a,"b,c",d\n1,2,3\n')).toEqual([
      ["a", "b,c", "d"],
      ["1", "2", "3"],
    ]);
  });

  it("holds the primary set fixed by the protocol", () => {
    const primary = registry
      .filter((r) => r.set === "primary")
      .map((r) => r.testPoint)
      .sort();
    expect(primary).toEqual(
      ["1A", "4", "32", "51", "10", "49", "53", "54", "55", "59", "27"].sort(),
    );
    // Panel outlets with a test value in the primary set: 10 points x 8 + TP10 x 4.
    let n = 0;
    for (const e of registry.filter((r) => r.set === "primary")) {
      for (const p of e.legs.flat()) {
        if (outlets[e.testPoint]?.[p]?.testF !== undefined) n++;
      }
    }
    expect(n).toBe(84);
  });

  it("applies the exclusions and data decisions recorded in the protocol", () => {
    const by = (tp: string) => registry.find((r) => r.testPoint === tp)!;
    expect(by("56").set).toBe("excluded");
    for (const tp of ["17", "17A", "36", "47"])
      expect(by(tp).set).toBe("excluded");
    expect(by("14").set).toBe("secondary");
    expect(by("45").set).toBe("secondary");
    expect(by("51").sides).toBe(2);
    // TP59 uses Volume II Appendix A (Table 2 repeats TP54).
    expect(by("59").flux[1]).toBeCloseTo(129.3, 6);
    expect(by("59").flux[8]).toBeCloseTo(11.1, 6);
    expect(by("54").flux[1]).toBeCloseTo(130.2, 6);
    // Inlet and flow of TP54 to TP59 are the test values from the maps.
    expect(by("54").tinF).toBeCloseTo(163.7, 6);
    expect(by("59").totalFlowLbhr).toBe(1975);
  });

  it("has leg fractions that sum to one and cover each leg", () => {
    for (const e of registry.filter((r) => r.fractions.length > 0)) {
      expect(e.fractions.length).toBe(e.legs.length);
      expect(e.fractions.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 4);
      for (const p of e.legs.flat()) expect(e.flux[p]).toBeDefined();
    }
  });
});

describe("MRS network builder", () => {
  it("splits the flow equally or by tube length over eleven tubes", () => {
    const eq = tubeFractions(0);
    expect(eq).toHaveLength(11);
    expect(eq.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    expect(eq[0]).toBeCloseTo(1 / 11, 12);
    const len = tubeFractions(1);
    expect(len.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    expect(len[10] / len[0]).toBeCloseTo(23 / 3, 10);
  });

  it("builds the documented sizes for one panel", () => {
    const { config, index } = buildMrsPanelNetwork({
      panel: 1,
      mdot: 0.1,
      tinF: 150,
      flux: 100,
      sides: 1,
    });
    // 11 tubes x 8 segments x (2 wall + 5 fin) solid unknowns, plus the sink.
    expect(index.nSolid).toBe(11 * 8 * 7);
    expect(index.nSolid).toBe(616);
    expect(config.solidNodes!.length).toBe(617);
    // 11 x 8 fluid nodes and the mixing node.
    expect(index.nFluid).toBe(89);
    const total = MRS_GEOMETRY.tubeLengthsFt.reduce((s, x) => s + x, 0);
    expect(total).toBe(143);
  });

  it("imposes the flow at each tube inlet and anchors the pressure elsewhere", () => {
    const { config, index } = buildMrsPanelNetwork(
      {
        panel: 3,
        mdot: 0.1,
        tinF: 150,
        flux: 100,
        sides: 1,
        tubes: [0, 5],
      },
      { segments: 3, finNodes: 2 },
    );
    const sources = config.branches.filter(
      (b) => b.component.type === "flowSource",
    );
    // One flowSource per tube, drawing from the inlet boundary.
    expect(sources.map((b) => b.from)).toEqual(["in", "in"]);
    expect(
      sources.reduce(
        (s, b) => s + (b.component as { massFlow: number }).massFlow,
        0,
      ),
    ).toBeCloseTo(0.1, 12);
    // Everything else is a viscosity-free resistance.
    const others = new Set(
      config.branches
        .filter((b) => b.component.type !== "flowSource")
        .map((b) => b.component.type),
    );
    expect([...others]).toEqual(["resistance"]);
    // The tube outlets and the panel flow end at the pressure boundary.
    expect(
      config.branches.some((b) => b.id === "b_out" && b.to === "out"),
    ).toBe(true);
    expect(index.mix).toBe("mix");
  });
});

describe("MRS convection expression", () => {
  const { c, d } = MRS_R21_TRANSPORT;
  const x = (T: number) => (T - 280) / 100;
  const muFit = (T: number) =>
    Math.exp(c.reduce((s, ci, i) => s + ci * x(T) ** i, 0));
  const kFit = (T: number) => d.reduce((s, di, i) => s + di * x(T) ** i, 0);

  it("fits the committed R21 transport table within 0.4 % and 0.25 %", () => {
    for (const r of table) {
      expect(Math.abs(muFit(r.T_K) / r.mu - 1)).toBeLessThan(0.004);
      expect(Math.abs(kFit(r.T_K) / r.k - 1)).toBeLessThan(0.0025);
    }
  });

  // Independent implementation: Gnielinski with the laminar blend, written out.
  const nuRef = (re: number, pr: number, lam = 3.66): number => {
    const gn = (r: number): number => {
      const f = (0.79 * Math.log(r) - 1.64) ** -2;
      return (
        ((f / 8) * (r - 1000) * pr) /
        (1 + 12.7 * Math.sqrt(f / 8) * (pr ** (2 / 3) - 1))
      );
    };
    if (re <= 2300) return lam;
    if (re >= 4000) return gn(re);
    const w = (re - 2300) / 1700;
    return (1 - w) * lam + w * gn(4000);
  };

  it("matches an independent Nusselt blend across laminar, transition and turbulent", () => {
    const expr = compileExpression(mrsConvectionExpression());
    const D = MRS_GEOMETRY.ID;
    const params: Record<string, number> = {
      muScale: 1,
      kScale: 1,
      nuLam: 3.66,
      hScale: 1,
    };
    c.forEach((v, i) => (params[`c${i}`] = v));
    d.forEach((v, i) => (params[`d${i}`] = v));
    const cp = 1000;
    for (const Tf of [230, 270, 310, 350]) {
      for (const re of [1500, 2300, 3100, 4000, 9000]) {
        const mu = muFit(Tf);
        const G = (re * mu) / D;
        const h = expr.evaluateNumber({ Tf, G, D, cp, params });
        const k = kFit(Tf);
        const href = (nuRef(re, (cp * mu) / k) * k) / D;
        expect(Math.abs(h / href - 1)).toBeLessThan(1e-9);
      }
    }
  });
});

describe("MRS panel solve", () => {
  beforeAll(async () => {
    await initRealFluids();
  }, 30000);

  it("closes the panel heat and mass balances and agrees with the hand calculation for one tube", () => {
    // TP1A panel 1 conditions, tube 6 only (50 lb/hr), segment refinement.
    const leg = {
      panels: [1],
      mdot: 50 * LBHR_TO_KGS,
      tinF: 178.3,
      flux: { 1: 135 },
      sides: 1 as const,
      tubes: [5],
    };
    const t4 = solveMrsLegChained(leg, { segments: 4 })[0];
    const t8 = solveMrsLegChained(leg, { segments: 8 })[0];
    for (const r of [t4, t8]) {
      expect(r.converged).toBe(true);
      expect(r.energyClosure).toBeLessThan(MRS_CLOSURE_LIMIT);
      expect(r.massClosure).toBeLessThan(1e-9);
      // Pressures are anchored: within a kilopascal of the loop pressure.
      expect(r.maxPressureOffset).toBeLessThan(1e3);
    }
    // The cell-outlet scheme converges from above and is first order.
    expect(t4.toutF).toBeGreaterThan(t8.toutF);
    expect(t8.toutF).toBeGreaterThan(142.34);
    const extrapolated = 2 * t8.toutF - t4.toutF;
    // Hand calculation (scripts/reference/mrs_hand_calc.py tube_march, 192
    // segments, same properties and fin conductivity 200.9 vs 201): 142.33 F.
    expect(Math.abs(extrapolated - 142.33)).toBeLessThan(0.25);
  }, 120000);

  it("does not throw when the requested tolerance is below the round-off floor", () => {
    // Regression for the first failure of this case.  A tolerance of 1e-11 is
    // under the raw-residual floor set by the pressure rows (1.5e-10), the solve
    // returns converged = false and its mixing node sits on the dome boundary
    // (T = 379.098 K = Tsat(R21, 1.5 MPa), where a PT flash throws).  The
    // closure used to throw TwoPhaseError.  Now the ladder loosens the tolerance
    // and returns a converged result.
    const leg = {
      panels: [1],
      mdot: 50 * LBHR_TO_KGS,
      tinF: 178.3,
      flux: { 1: 135 },
      sides: 1 as const,
      tubes: [5],
    };
    const r = solveMrsLegChained(leg, { segments: 4, tolerance: 1e-11 })[0];
    expect(r.converged).toBe(true);
    expect(r.tolerance).toBeGreaterThan(1e-11);
    expect(r.toutF).toBeGreaterThan(140);
    expect(r.toutF).toBeLessThan(150);
  }, 60000);

  it("runs the TP1A chain of four full panels at 4 segments against the hand calculation and the test", () => {
    // System-level check of the primary trace (the full N = 8 and N = 16 runs
    // are in scripts/mrs-validation-report.ts).  Measured at N = 4, panels
    // 1, 3, 4, 2 of the first TP1A chain (about 6 s):
    //   OpenFLUME 145.94, 124.91, 111.90, 103.70 F
    //   hand calc 144.00, 122.49, 109.66, 101.82 F  (OpenFLUME - hand 1.94, 2.42, 2.24, 1.88)
    //   test      139.2,  118.0,  105.0,   98.0 F   (OpenFLUME - test 6.74, 6.91, 6.90, 5.70)
    // The N = 4 scheme is first order and the segmented scheme overpredicts by
    // about 2 F, which the N = 8 and N = 16 runs of the report remove.  Gates
    // are 1.5 times the largest measured difference.
    const e = registry.find((r) => r.testPoint === "1A");
    if (!e) throw new Error("TP1A missing");
    const hand = parseCsvRecords(read("mrs_hand_calc_results.csv")).filter(
      (r) => r.test_point === "1A",
    );
    const handOf = (p: number): number =>
      Number(hand.find((r) => Number(r.panel) === p)?.Tout_calc_F);
    const leg = {
      panels: e.legs[0],
      mdot: e.totalFlowLbhr * e.fractions[0] * LBHR_TO_KGS,
      tinF: e.tinF,
      flux: e.flux,
      sides: e.sides,
    };
    const runs = solveMrsLegChained(leg, { segments: 4 });
    expect(runs.map((r) => r.panel)).toEqual([1, 3, 4, 2]);
    let prev = e.tinF;
    for (const r of runs) {
      expect(r.converged).toBe(true);
      expect(r.energyClosure).toBeLessThan(MRS_CLOSURE_LIMIT);
      expect(r.massClosure).toBeLessThan(1e-9);
      expect(r.toutF).toBeLessThan(prev);
      prev = r.toutF;
      const test = outlets["1A"][r.panel].testF as number;
      expect(Math.abs(r.toutF - handOf(r.panel))).toBeLessThan(3.7);
      expect(Math.abs(r.toutF - test)).toBeLessThan(10.4);
    }
  }, 60000);

  it("computes simple error statistics", () => {
    const s = errorStats([3, -4]);
    expect(s.n).toBe(2);
    expect(s.rms).toBeCloseTo(Math.sqrt(12.5), 12);
    expect(s.maxAbs).toBe(4);
    expect(s.bias).toBeCloseTo(-0.5, 12);
  });
});
