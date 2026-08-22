/**
 * Chilldown BASELINE (Stage 0) — our "before" number against the NBS/GFSSP
 * Table-6 LN2 data, computed the defensible way:
 *
 *   - objective: chilldown time at STATION 4 (60.35 m), the NBS-9264
 *     definition (low-temperature knee of the wall-T curve 60.4 m from the
 *     dewar) — see src/validation/nbsChilldown.ts header;
 *   - wall traces interpolated IN SPACE to the true station coordinate
 *     (no nearest-node snapping);
 *   - smooth (linearly interpolated) threshold crossing — never the naive
 *     piecewise-constant first-below;
 *   - timeStepping: 'fixed' (adaptive stepping makes dt a discontinuous
 *     function of parameters and destroys differentiability);
 *   - outletWallCoupling: 'upwind' so the last wall node chills and
 *     station 4 is bracketed by physical wall samples.
 *
 * CI scale: ONE representative N=3 case (saturated 74.97 psia, ~60–90 s
 * with the retry cascade).  The full 4-case suite (3
 * saturated + matched subcooled 74.97) runs under RUN_SLOW=1
 * (`npm run test:slow`) — see docs/testing-slow.md.  The expensive
 * N-sweep (grid convergence) is the manually-run
 * scripts/chilldown-baseline.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { describeSlow } from "../../testUtils/slow";
import { buildChilldownTwoPhase } from "../examples";
import {
  solveTransient,
  initRealFluids,
  RealFluid,
  physicalPosition,
  type NetworkConfig,
  type TransientResult,
} from "../../core";
import {
  getChilldownPoints,
  NBS_CHILLDOWN_RIG,
  DEFAULT_CHILLDOWN_TIME_DEFINITION,
  type ChilldownDataPoint,
  type ChilldownTimeDefinition,
} from "../../validation/nbsChilldown";
import {
  predictedChilldownTime,
  predictedChilldownTimeSweep,
  type ChilldownMetricInput,
} from "../../validation/chilldownMetric";
import { interpolateTraceToStation } from "../../validation/stationInterp";

// Hang-guard timeout per case (not a physics gate): the retry
// cascade runs Newton retries on the subcooled case's hard
// dome-edge steps, so a case that took ~10–20 s with the old vacuous
// convergence now takes ~40–90 s in isolation and > 120 s when the full
// suite competes for CPU.  300 s matches vitest's per-test timeout.
const SOLVE_TIMEOUT_S = 300;
const N = 3;

interface CaseResult {
  point: ChilldownDataPoint;
  cfg: NetworkConfig;
  res: TransientResult;
  input: ChilldownMetricInput;
}

let fluid: RealFluid;
const cases: CaseResult[] = [];
let ciCase: CaseResult | undefined;

function assertNoNaN(res: TransientResult) {
  for (const node of Object.values(res.nodes)) {
    expect(node.pressure.some(isNaN)).toBe(false);
    expect(node.temperature.some(isNaN)).toBe(false);
    expect(node.density.some(isNaN)).toBe(false);
  }
  for (const sn of Object.values(res.solidNodes ?? {})) {
    expect(sn.temperature.some(isNaN)).toBe(false);
  }
  for (const br of Object.values(res.branches)) {
    expect(br.mdot.some(isNaN)).toBe(false);
  }
}

function runCase(point: ChilldownDataPoint): CaseResult {
  const subcooled = point.inletCondition === "subcooled";
  const cfg = buildChilldownTwoPhase({
    segments: N,
    length: NBS_CHILLDOWN_RIG.lengthM,
    drivingPressure: point.drivingPressure.pa,
    outletPressure: 101325,
    ...(subcooled ? { inletTemperature: point.subcooledAtTemperature!.K } : {}),
    outletWallCoupling: "upwind",
    dt: 10,
    endTime: subcooled ? 360 : 300,
    timeStepping: "fixed",
  });
  const start = process.hrtime.bigint();
  const res = solveTransient(cfg, {
    shouldAbort: () =>
      Number(process.hrtime.bigint() - start) / 1e9 > SOLVE_TIMEOUT_S,
  });
  const input: ChilldownMetricInput = {
    timesS: res.times,
    wallXM: cfg.solidNodes!.map((s) => physicalPosition(s)?.x ?? s.x),
    wallTracesK: cfg.solidNodes!.map((s) => res.solidNodes![s.id].temperature),
    fluidXM: cfg.nodes.map((n) => physicalPosition(n)?.x ?? n.x),
    pressureTracesPa: cfg.nodes.map((n) => res.nodes[n.id].pressure),
    inletLiquidTempK: subcooled
      ? point.subcooledAtTemperature!.K
      : fluid.saturationTemperature(point.drivingPressure.pa),
    saturationTemperatureK: (pPa) => fluid.saturationTemperature(pPa),
  };
  return { point, cfg, res, input };
}

beforeAll(async () => {
  await initRealFluids();
  fluid = new RealFluid("Nitrogen");
  // CI representative case: one saturated N=3 solve (~60–90 s with the
  // retry cascade).  The full 4-case suite (3 saturated +
  // matched subcooled 74.97) moved to describeSlow below — see
  // docs/testing-slow.md.
  const sat74 =
    getChilldownPoints("LN2", "saturated").find(
      (p) => p.id === "satLN2-P74.97",
    ) ?? getChilldownPoints("LN2", "saturated")[1];
  ciCase = runCase(sat74);
}, 300000);

beforeAll(async () => {
  if (process.env.RUN_SLOW !== "1") return;
  await initRealFluids();
  fluid = new RealFluid("Nitrogen");
  const sat = getChilldownPoints("LN2", "saturated"); // 61.74 / 74.97 / 86.73 psia
  const sub74 = getChilldownPoints("LN2", "subcooled").find(
    (p) => p.id === "subLN2-P74.97",
  )!;
  for (const p of [...sat, sub74]) {
    // Yield to the event loop between solves: each solveTransient is a long
    // SYNCHRONOUS block (60–150 s), and an unbroken multi-solve stretch
    // starves vitest's worker RPC (observed: 'Timeout calling
    // onTaskUpdate', worker killed, remaining tests in the file lost).
    await new Promise((r) => setImmediate(r));
    cases.push(runCase(p));
  }
  // 600 s hook budget: with the retry cascade the subcooled
  // case's hard dome-edge steps now run Newton retries (~90–150 s
  // for that case alone when the full suite runs files in parallel and
  // competes for CPU), so the previous 300 s budget timed out spuriously.
}, 600000);

describe("NBS Table-6 chilldown baseline — CI representative case (N=3, sat 74.97 psia)", () => {
  it("converges with no NaN (and was not timeout-aborted)", () => {
    expect(ciCase).toBeDefined();
    expect(ciCase!.res.aborted).toBeFalsy();
    expect(ciCase!.res.converged).toBe(true);
    assertNoNaN(ciCase!.res);
  });

  it("station-4 chilldown time sits inside the wide band", () => {
    const m = predictedChilldownTime(
      ciCase!.input,
      DEFAULT_CHILLDOWN_TIME_DEFINITION,
    );
    expect(m.timeS).toBeDefined();
    const exp = ciCase!.point.experimentalChilldownTimeS;
    const gfssp = ciCase!.point.gfsspPredictedChilldownTimeS;
    console.log(
      `CI baseline: sat 74.97 psia | exp=${exp}s | GFSSP=${gfssp}s | ours=${m.timeS!.toFixed(1)}s (${(((m.timeS! - exp) / exp) * 100).toFixed(1)}%)`,
    );
    // Same wide band as the full suite: catches gross regressions (no
    // crossing, factor-2 drift) without pretending the coarse-N model is
    // exact.  Measured: ~128–160 s (exp 150 s) across solver versions.
    expect(m.timeS!).toBeGreaterThan(exp * 0.5);
    expect(m.timeS!).toBeLessThan(exp * 1.6);
  });

  it("smooth crossing brackets the naive first-below time on real traces", () => {
    const m = predictedChilldownTime(
      ciCase!.input,
      DEFAULT_CHILLDOWN_TIME_DEFINITION,
    );
    const trace = interpolateTraceToStation(
      ciCase!.input.wallXM,
      ciCase!.input.wallTracesK,
      m.stationXM,
    );
    const naiveIdx = trace.findIndex((v) => v < m.thresholdK);
    expect(naiveIdx).toBeGreaterThan(0);
    expect(m.timeS!).toBeGreaterThan(ciCase!.input.timesS[naiveIdx - 1]);
    expect(m.timeS!).toBeLessThanOrEqual(ciCase!.input.timesS[naiveIdx]);
    // And the smooth value is (for this trace) strictly inside the bracket —
    // i.e. not glued to a sample boundary like the piecewise-constant version.
    expect(m.timeS!).toBeLessThan(ciCase!.input.timesS[naiveIdx]);
  });
});

describeSlow(
  "NBS Table-6 chilldown baseline (N=3, LN2, full 4-case suite)",
  () => {
    it("all cases converge with no NaN (and were not timeout-aborted)", () => {
      expect(cases.length).toBe(4);
      for (const c of cases) {
        expect(c.res.aborted).toBeFalsy();
        expect(c.res.converged).toBe(true);
        assertNoNaN(c.res);
      }
    });

    it("baseline table: saturated LN2 vs experiment vs GFSSP published prediction", () => {
      const rows: string[] = [];
      const errs: number[] = [];
      for (const c of cases.slice(0, 3)) {
        const m = predictedChilldownTime(
          c.input,
          DEFAULT_CHILLDOWN_TIME_DEFINITION,
        );
        expect(m.timeS).toBeDefined();
        const exp = c.point.experimentalChilldownTimeS;
        const gfssp = c.point.gfsspPredictedChilldownTimeS;
        const ourErr = ((m.timeS! - exp) / exp) * 100;
        const gfsspErr = ((gfssp - exp) / exp) * 100;
        errs.push(Math.abs(ourErr));
        rows.push(
          `P=${c.point.drivingPressure.psia} psia | exp=${exp}s | GFSSP=${gfssp}s (${gfsspErr >= 0 ? "+" : ""}${gfsspErr.toFixed(1)}%) | ours=${m.timeS!.toFixed(1)}s (${ourErr >= 0 ? "+" : ""}${ourErr.toFixed(1)}%) | thresh=${m.thresholdK.toFixed(1)}K`,
        );
        // Wide band per case: catches gross regressions (no crossing,
        // factor-2 drift) without pretending the coarse-N model is exact.
        expect(m.timeS!).toBeGreaterThan(exp * 0.5);
        expect(m.timeS!).toBeLessThan(exp * 1.6);
      }
      console.log("BASELINE (N=3, station-4 knee, Tsat_local+15 K):");
      for (const r of rows) console.log("  " + r);
      // Measured N=3 mean |err| = 12.8%; assert < 25% as a regression sentinel.
      const meanAbsPct = errs.reduce((a, b) => a + b, 0) / errs.length;
      console.log(`  mean |our err| = ${meanAbsPct.toFixed(1)}%`);
      expect(meanAbsPct).toBeLessThan(25);
    });

    it("physics: chilldown time strictly decreases with driving pressure", () => {
      const times = cases
        .slice(0, 3)
        .map(
          (c) =>
            predictedChilldownTime(c.input, DEFAULT_CHILLDOWN_TIME_DEFINITION)
              .timeS!,
        );
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeLessThan(times[i - 1]);
      }
    });

    it("physics: subcooling shortens chilldown at matched pressure (74.97 psia)", () => {
      // cases: [sat 61.74, sat 74.97, sat 86.73, sub 74.97] — matched pair is 1 vs 3.
      const sat = predictedChilldownTime(
        cases[1].input,
        DEFAULT_CHILLDOWN_TIME_DEFINITION,
      ).timeS!;
      const sub = predictedChilldownTime(
        cases[3].input,
        DEFAULT_CHILLDOWN_TIME_DEFINITION,
      ).timeS!;
      expect(cases[1].point.drivingPressure.psia).toBe(
        cases[3].point.drivingPressure.psia,
      );
      console.log(
        `74.97 psia: saturated=${sat.toFixed(1)}s subcooled=${sub.toFixed(1)}s`,
      );
      expect(sub).toBeLessThan(sat);
      // Table-6 values at 74.97 psia: sat 150 s, sub 100 s — sub should ALSO
      // be below the saturated experimental value here (measured: sub=128.1).
      expect(sub).toBeLessThan(cases[1].point.experimentalChilldownTimeS);
    });

    it("smooth crossing brackets the naive first-below time on real traces", () => {
      const c = cases[1]; // sat 74.97
      const m = predictedChilldownTime(
        c.input,
        DEFAULT_CHILLDOWN_TIME_DEFINITION,
      );
      // Naive first-below on the same interpolated station-4 trace.
      const trace = interpolateTraceToStation(
        c.input.wallXM,
        c.input.wallTracesK,
        m.stationXM,
      );
      const naiveIdx = trace.findIndex((v) => v < m.thresholdK);
      expect(naiveIdx).toBeGreaterThan(0);
      expect(m.timeS!).toBeGreaterThan(c.input.timesS[naiveIdx - 1]);
      expect(m.timeS!).toBeLessThanOrEqual(c.input.timesS[naiveIdx]);
      // And the smooth value is (for this trace) strictly inside the bracket —
      // i.e. not glued to a sample boundary like the piecewise-constant version.
      expect(m.timeS!).toBeLessThan(c.input.timesS[naiveIdx]);
    });

    it("definitional sensitivity is computed and reported (not hidden)", () => {
      const defs: ChilldownTimeDefinition[] = [
        { station: 4, threshold: { mode: "aboveLocalTsat", marginK: 15 } },
        { station: 4, threshold: { mode: "aboveLocalTsat", marginK: 30 } },
        { station: 4, threshold: { mode: "aboveInletLiquid", marginK: 15 } },
        { station: 4, threshold: { mode: "fixed", valueK: 100 } },
        { station: 3, threshold: { mode: "aboveLocalTsat", marginK: 15 } },
      ];
      for (const c of cases.slice(0, 3)) {
        const r = predictedChilldownTimeSweep(c.input, defs);
        const [m15, m30, inlet15, fixed100, sta3] = r.map((x) => x.timeS);
        console.log(
          `P=${c.point.drivingPressure.psia}: m15=${m15?.toFixed(1)} m30=${m30?.toFixed(1)} inlet+15=${inlet15?.toFixed(1)} 100K=${fixed100?.toFixed(1)} sta3=${sta3?.toFixed(1)}`,
        );
        for (const x of r) {
          if (x.timeS !== undefined) expect(x.timeS).toBeGreaterThan(0);
        }
      }
    });
  },
);
