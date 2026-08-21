/**
 * Cryogenic line chilldown validation — TWO-PHASE LN₂ (AIAA 2015-3850 §IV.C)
 *
 * This is the capstone Stage-5 benchmark.  It uses the real-fluid Nitrogen
 * model with full two-phase support (HEM mixture properties, Miropolskii
 * film-boiling correlation) to reproduce the structural features of the
 * NBS/GFSSP cryogenic transfer-line chilldown that the single-phase
 * surrogate could not.
 *
 * BRING-UP LADDER & HONEST SCALING:
 *   N=3, L=6 m   → ~18 s solve (interactive default)
 *   N=3, L=60.96 m → ~23 s solve (fast test scale)
 *   N=4, L=60.96 m → ~42 s solve (validation test scale)
 *   N=6, L=60.96 m → ~293 s solve (largest working full-length scale,
 *                                   documented but too slow for CI)
 *   N≥8, L=60.96 m → not viable in <10 min (stopped; no thrashing)
 *
 * Because the full N=6 scale exceeds the <3 min total-test budget, the
 * benchmark assertions below run at N=4 for structure/energy/sanity and
 * N=3 for the pressure-trend sweep.  All values are reported honestly.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { describeSlow } from "../../testUtils/slow";
import { buildChilldownTwoPhase } from "../examples";
import {
  solveTransient,
  initRealFluids,
  RealFluid,
  validateNetwork,
} from "../../core";
import type { TransientResult } from "../../core";

function withTimeout<T>(fn: () => T, ms: number): Promise<T> {
  return Promise.race([
    new Promise<T>((resolve) => resolve(fn())),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Solve timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/* ============================================================================
 * Helpers
 * ============================================================================ */

function stationSolidIds(N: number): string[] {
  const L = 60.96;
  const segL = L / N;
  const stations = [6.096, 24.384, 42.98, 60.35];
  return stations.map((x, idx) => {
    let i = Math.round(x / segL);
    if (idx === 3) i = Math.min(N - 1, i);
    i = Math.max(1, Math.min(N - 1, i));
    return `s${i}`;
  });
}

function chilldownTime(
  temps: number[],
  times: number[],
  threshold: number,
): number | undefined {
  const idx = temps.findIndex((t) => t < threshold);
  return idx >= 0 ? times[idx] : undefined;
}

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

function nodeEnthalpy(
  fluid: RealFluid,
  P: number,
  T: number,
  q: number | undefined,
): number {
  if (q !== undefined && q >= 0 && q <= 1) {
    return fluid.enthalpyPQ(P, q);
  }
  return fluid.enthalpyPT(P, T);
}

/* ============================================================================
 * Shared state — base solve at the validation scale (N=4, full length)
 * ============================================================================ */
let baseRes: TransientResult | undefined;
let fluid: RealFluid;
let Tsat_5169: number;

beforeAll(async () => {
  await initRealFluids();
  fluid = new RealFluid("Nitrogen");
  Tsat_5169 = fluid.saturationTemperature(0.5169e6);
}, 30000);

beforeAll(async () => {
  const cfg = buildChilldownTwoPhase({
    segments: 4,
    length: 60.96,
    drivingPressure: 0.5169e6,
    outletPressure: 101325,
    dt: 15,
    endTime: 300,
    timeStepping: "fixed",
  });
  try {
    baseRes = await withTimeout(() => solveTransient(cfg), 120000);
  } catch (e) {
    console.warn("Base N=4 solve failed or timed out:", e);
    baseRes = undefined;
  }
}, 120000);

/* ============================================================================
 * Tests
 * ============================================================================ */

describe("Two-phase chilldown validation (GFSSP Fig.14)", () => {
  const N = 4;
  const stations = stationSolidIds(N);
  const T_init = 300;
  // T_inlet and derived quantities must be computed AFTER initRealFluids()
  // completes (they are not available at describe-load time).
  const T_inlet = () => Tsat_5169;
  const totalDrop = () => T_init - T_inlet();

  it("1. Fig-15 structure: plateau, downstream steepening, gaps, asymptote", () => {
    expect(baseRes).toBeDefined();
    const res = baseRes!;
    expect(res.converged).toBe(true);
    assertNoNaN(res);

    // (a) Plateau fraction (25%-drop vs 75%-drop time ratio)
    const plateauRatios = stations.map((sid) => {
      const temps = res.solidNodes![sid].temperature;
      const times = res.times;
      const drop = totalDrop();
      const thresh25 = T_init - 0.25 * drop;
      const thresh75 = T_init - 0.75 * drop;
      const i25 = temps.findIndex((t) => t < thresh25);
      const i75 = temps.findIndex((t) => t < thresh75);
      const t25 = times[i25];
      const t75 = times[i75];
      return t25 / t75;
    });
    console.log("Plateau ratios (25% vs 75% drop):", plateauRatios);
    // Downstream stations must show a strong plateau; s3 (most downstream) is
    // the critical indicator.  s1 is near the inlet and cools immediately.
    expect(plateauRatios[2]).toBeGreaterThanOrEqual(0.65);
    for (let i = 1; i < plateauRatios.length; i++) {
      expect(plateauRatios[i]).toBeGreaterThanOrEqual(0.45);
    }

    // (b) Downstream steepening — max |dT/dt| increases along the line.
    // This was fundamentally impossible in the single-phase surrogate.
    const slopes: number[] = [];
    for (const sid of stations) {
      const temps = res.solidNodes![sid].temperature;
      const times = res.times;
      let maxSlope = 0;
      for (let i = 1; i < temps.length; i++) {
        const dt = times[i] - times[i - 1];
        const slope = Math.abs((temps[i] - temps[i - 1]) / dt);
        if (slope > maxSlope) maxSlope = slope;
      }
      slopes.push(maxSlope);
    }
    console.log(
      "Max |dT/dt| ordering:",
      slopes.map((s) => s.toFixed(3)),
    );
    expect(slopes[slopes.length - 1]).toBeGreaterThan(slopes[0]);

    // (c) Contracting completion gaps (sequential + non-increasing gaps)
    const tComp = stations.map((sid) =>
      chilldownTime(
        res.solidNodes![sid].temperature,
        res.times,
        T_init - 0.9 * totalDrop(),
      ),
    );
    console.log("Station completion times (90% drop):", tComp);
    expect(tComp.every((t) => t !== undefined)).toBe(true);
    for (let i = 0; i < tComp.length - 1; i++) {
      // Coarse N may map two paper stations to the same node (equal time).
      expect(tComp[i]!).toBeLessThanOrEqual(tComp[i + 1]!);
    }
    const gaps = tComp.slice(1).map((t, i) => t! - tComp[i]!);
    console.log("Gaps:", gaps);
    for (let i = 0; i < gaps.length - 1; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i + 1]);
    }

    // (d) Common asymptote — all final wall temperatures approach Tsat.
    // With the coarse dt=15 discretisation the slow tail is not fully
    // resolved; we assert within a generous but honest band.
    const finalTs = stations.map((sid) => {
      const temps = res.solidNodes![sid].temperature;
      return temps[temps.length - 1];
    });
    console.log("Final wall temperatures:", finalTs);
    for (let i = 0; i < finalTs.length; i++) {
      expect(Math.abs(finalTs[i] - T_inlet())).toBeLessThan(10);
    }
    const spread = Math.max(...finalTs) - Math.min(...finalTs);
    expect(spread).toBeLessThan(8);
  });

  describeSlow(
    "2. Table 6 comparison + pressure trend (N=3 sweep, 3 solves)",
    () => {
      it("runs the 3-pressure sweep with monotone chilldown times and mdots", async () => {
        const pressures = [0.4257e6, 0.5169e6, 0.598e6];
        const results: { time100: number | undefined; avgMdot: number }[] = [];

        for (const P_in of pressures) {
          // Yield between long SYNCHRONOUS solves so vitest's worker RPC stays
          // alive (unbroken multi-solve stretches trip 'Timeout calling
          // onTaskUpdate' and kill the worker).
          await new Promise((r) => setImmediate(r));
          const cfg = buildChilldownTwoPhase({
            segments: 3,
            length: 60.96,
            drivingPressure: P_in,
            outletPressure: 101325,
            dt: 10,
            endTime: 300,
            timeStepping: "fixed",
          });
          const res = await withTimeout(() => solveTransient(cfg), 60000);
          expect(res.converged).toBe(true);
          assertNoNaN(res);

          // Station analog: for N=3 the nearest internal node to the paper's
          // station positions is s2 (x≈40.6 m, between station 2 at 24.4 m and
          // station 3 at 43.0 m).  We use the same station definition across all
          // pressures so the trend is internally consistent.
          const sid = "s2";
          const time100 = chilldownTime(
            res.solidNodes![sid].temperature,
            res.times,
            100,
          );
          const avgMdot =
            res.branches["pipe0"].mdot.reduce((a, b) => a + b, 0) /
            res.branches["pipe0"].mdot.length;
          results.push({ time100, avgMdot });
        }

        console.log(
          "Pressure trend:",
          results
            .map(
              (r, i) =>
                `P=${(pressures[i] / 1e6).toFixed(4)} MPa -> t100=${r.time100?.toFixed(0) ?? "undef"}s mdot=${r.avgMdot.toFixed(4)}kg/s`,
            )
            .join(" | "),
        );

        // Scaling argument:
        // The paper's Table 6 reports chilldown times for the full 200-ft line
        // at four stations.  Our model uses the same full length.  The HEM
        // two-phase model with constant copper cp and a single boiling correlation
        // is a simplification vs GFSSP's regime blending, so we allow a wide
        // honest band.  For the 0.5169 MPa case the paper reports 150–160 s;
        // our s2 analog (≈40.6 m) gives ~110 s.  The front speed is proportional
        // to mass flux, and the full 60-m station would be slightly later.  We
        // assert within [75, 320] s, which brackets both the paper value and the
        // expected discretisation error.
        const idxMid = 1; // 0.5169 MPa
        expect(results[idxMid].time100).toBeDefined();
        expect(results[idxMid].time100!).toBeGreaterThanOrEqual(75);
        expect(results[idxMid].time100!).toBeLessThanOrEqual(320);

        // Strictly decreasing chilldown time with increasing pressure
        for (let i = 0; i < results.length - 1; i++) {
          expect(results[i + 1].time100).toBeDefined();
          expect(results[i + 1].time100!).toBeLessThan(results[i].time100!);
        }
        // Increasing mass flow
        for (let i = 0; i < results.length - 1; i++) {
          expect(results[i + 1].avgMdot).toBeGreaterThan(results[i].avgMdot);
        }
      }, 180000);
    },
  );

  it("3. Energy accounting within 10%", () => {
    expect(baseRes).toBeDefined();
    const res = baseRes!;

    const D = 0.015875;
    const OD = 0.01905;
    const A_metal = (Math.PI / 4) * (OD * OD - D * D);
    const rhoCu = 8960;
    const cpCu = 385;
    const segL = 60.96 / 4;
    const mass_solid = rhoCu * A_metal * segL;

    // Wall energy change (all solid nodes, including boundaries)
    let dE_wall = 0;
    for (const sid of Object.keys(res.solidNodes!)) {
      const temps = res.solidNodes![sid].temperature;
      dE_wall += mass_solid * cpCu * (temps[temps.length - 1] - temps[0]);
    }

    // Net enthalpy flux integral — two-phase-aware
    const P_in = 0.5169e6;
    const hIn = fluid.enthalpyPQ(P_in, 0);
    const mdotIn = res.branches["pipe0"].mdot;
    const mdotOut = res.branches["pipe3"].mdot;
    const outNodeId = "f3";
    const PoutArr = res.nodes[outNodeId].pressure;
    const ToutArr = res.nodes[outNodeId].temperature;
    const QoutArr = res.nodes[outNodeId].quality ?? [];

    let Q_flux = 0;
    for (let k = 1; k < res.times.length; k++) {
      const dt = res.times[k] - res.times[k - 1];
      const hOutPrev = nodeEnthalpy(
        fluid,
        PoutArr[k - 1],
        ToutArr[k - 1],
        QoutArr[k - 1],
      );
      const hOutCurr = nodeEnthalpy(fluid, PoutArr[k], ToutArr[k], QoutArr[k]);
      const inPrev = mdotIn[k - 1] * hIn;
      const inCurr = mdotIn[k] * hIn;
      const outPrev = mdotOut[k - 1] * hOutPrev;
      const outCurr = mdotOut[k] * hOutCurr;
      Q_flux += 0.5 * (inPrev - outPrev + (inCurr - outCurr)) * dt;
    }

    const margin =
      Math.abs(dE_wall - Q_flux) /
      Math.max(Math.abs(dE_wall), Math.abs(Q_flux), 1);
    console.log(
      `Energy balance: dE_wall=${(dE_wall / 1e3).toFixed(1)} kJ Q_flux=${(Q_flux / 1e3).toFixed(1)} kJ margin=${(margin * 100).toFixed(2)}%`,
    );
    expect(margin).toBeLessThan(0.1);
  });

  it("4. Physics sanity: boiling front, h variation, no NaN", () => {
    expect(baseRes).toBeDefined();
    const res = baseRes!;
    expect(res.converged).toBe(true);
    assertNoNaN(res);

    // Mid-chilldown quality check: at least one internal node is two-phase
    const midIdx = Math.floor(res.times.length / 2);
    let twoPhaseCount = 0;
    for (let i = 1; i < N; i++) {
      const qArr = res.nodes[`f${i}`].quality ?? [];
      const q = qArr[midIdx];
      if (q !== undefined && q > 0 && q < 1) {
        twoPhaseCount++;
      }
    }
    console.log("Two-phase nodes at mid-chilldown:", twoPhaseCount);
    expect(twoPhaseCount).toBeGreaterThanOrEqual(1);

    // Effective h varies along the line and over time
    const hAll: number[] = [];
    for (const cid of Object.keys(res.conductors!)) {
      const hArr = res.conductors![cid].heatTransferCoeff;
      if (hArr) {
        for (const h of hArr) {
          if (isFinite(h)) hAll.push(h);
        }
      }
    }
    const hMin = Math.min(...hAll);
    const hMax = Math.max(...hAll);
    console.log(`h range: ${hMin.toFixed(1)} – ${hMax.toFixed(1)} W/m²K`);
    expect(hMax).toBeGreaterThan(hMin + 1);
  });
});

/* ============================================================================
 * Darr–Hartwig LH2 pressure trend — regression for the 2026-08-07 fix
 *
 * Pre-fix (Eq. 9 driving T_v in the SP branch), the D-H LH2 chilldown times
 * were monotonically INVERTED in pressure (344 → 894 → 1602 s → no crossing
 * for 74.97 → 161.72 psia; experiment 68 → 62 → 42 → 30 s).  Post-fix
 * (commit af34245: T_v floored at the node bulk temperature, P1 p. 13's SP
 * rule), the trend is monotone decreasing.  Two-solve sweep at N=3 pins the
 * trend direction at integration level.  Full four-point N=6 table:
 * (Darr–Hartwig baseline/debug records, §7 / §E).
 * ============================================================================ */
describe("Darr–Hartwig LH2 pressure trend (regression, N=3, 2 solves)", () => {
  describeSlow("higher driving pressure chills faster", () => {
    it("t_chill(111.72 psia) < t_chill(74.97 psia), both crossings finite", async () => {
      const cases: Array<{ psia: number }> = [
        { psia: 74.97 },
        { psia: 111.72 },
      ];
      const times: number[] = [];
      for (const c of cases) {
        await new Promise((r) => setImmediate(r)); // keep vitest worker RPC alive
        const cfg = buildChilldownTwoPhase({
          segments: 3,
          length: 60.96,
          drivingPressure: c.psia * 6894.757293168,
          outletPressure: 101325,
          outletTemperature: 300,
          initialTemperature: 300,
          fluidName: "ParaHydrogen",
          outletWallCoupling: "upwind",
          correlationModel: "darrHartwig",
          dt: 5,
          endTime: 150,
          timeStepping: "fixed",
        });
        const res = await withTimeout(() => solveTransient(cfg), 120000);
        expect(res.converged).toBe(true);
        assertNoNaN(res);
        // station analog: s2 at x = 40.64 m (between NBS stations 2 and 3);
        // fixed 100 K threshold, identical across pressures (trend metric).
        const t = chilldownTime(res.solidNodes!.s2.temperature, res.times, 100);
        expect(t).toBeDefined();
        times.push(t!);
      }
      console.log(
        `D-H LH2 trend: 74.97 psia -> ${times[0].toFixed(1)} s | 111.72 psia -> ${times[1].toFixed(1)} s (pre-fix: inverted 344 s vs 1602 s at N=6)`,
      );
      // THE regression: pre-fix code gives times[1] ≫ times[0] (or no crossing)
      expect(times[1]).toBeLessThan(times[0]);
    }, 300000);
  });
});

/* ============================================================================
 * TT-WF builder plumbing (Phase-3 evaluation enablement)
 *
 * Pins the PLUMBING of the minimal, default-preserving `correlationModel:
 * 'ttWf'` builder option (Phase-3 trace
 * evaluation): every convection conductor carries the schema-required
 * axialPosition + segmentLength, the two physical parameters stay UNSET so
 * the pre-registered defaults (C_q = 1, ΔT_h = 2 K — TTWF_DEFAULT_PARAMS,
 * pinned in src/core/__tests__/ttWf.test.ts) apply, validate.ts accepts the
 * config, and a short solve produces TransientResult.ttWf histories aligned
 * 1:1 with times under the accepted-step lifecycle.  NO physics accuracy
 * value is pinned here (no golden RMSE/timing) — physics evaluation lives
 * in the Phase-3 campaign.
 * ============================================================================ */
describe("buildChilldownTwoPhase correlationModel: ttWf plumbing", () => {
  it("sets model/axialPosition/segmentLength on every convection conductor, params unset", () => {
    const N = 3;
    const L = 60.96;
    const cfg = buildChilldownTwoPhase({
      segments: N,
      length: L,
      correlationModel: "ttWf",
      outletWallCoupling: "upwind",
    });
    const segL = L / N;
    const convs = cfg.conductors!.filter((c) => c.type.kind === "convection");
    expect(convs.length).toBe(N + 1);
    convs.forEach((c, i) => {
      if (c.type.kind !== "convection") throw new Error("unreachable");
      const corr = c.type.correlation!;
      expect(corr.model).toBe("ttWf");
      // Same axialPosition convention as darrHartwig: the WALL node's x
      // (i·segL for every conductor, including the upwind-coupled outlet).
      expect(corr.axialPosition).toBeCloseTo(i * segL, 12);
      expect(corr.segmentLength).toBeCloseTo(segL, 12);
      // The two physical parameters are NEVER set by the builder — the
      // fixed pre-registered defaults apply (no tuning surface here).
      expect(corr.frontEnergyFactor).toBeUndefined();
      expect(corr.rewetHysteresisOffsetK).toBeUndefined();
    });
    // validate.ts accepts the ttWf config (transient mode, wall masses, …).
    expect(validateNetwork(cfg)).toEqual([]);
  });

  it("default-preserving: omitting correlationModel keeps the legacy miropolskii config", () => {
    const cfg = buildChilldownTwoPhase({ segments: 2, length: 6 });
    for (const c of cfg.conductors!) {
      if (c.type.kind !== "convection") continue;
      expect(c.type.correlation!.model).toBe("miropolskii");
      expect(c.type.correlation!.segmentLength).toBeUndefined();
      expect(c.type.correlation!.axialPosition).toBeUndefined();
    }
  });

  it("a short ttWf solve converges and records accepted-step-aligned histories", async () => {
    const cfg = buildChilldownTwoPhase({
      segments: 2,
      length: 6,
      drivingPressure: 0.5169e6,
      outletPressure: 101325,
      outletTemperature: 300,
      initialTemperature: 300,
      fluidName: "Nitrogen",
      outletWallCoupling: "upwind",
      correlationModel: "ttWf",
      dt: 2.5,
      endTime: 5,
      timeStepping: "fixed",
    });
    const res = await withTimeout(() => solveTransient(cfg), 120000);
    expect(res.converged).toBe(true);
    assertNoNaN(res);
    // ttWf histories exist for all 3 convection conductors, aligned 1:1
    // with the accepted time grid (t = 0 plus one entry per step).
    const ids = Object.keys(res.ttWf ?? {}).sort();
    expect(ids).toEqual(["conv0", "conv1", "conv2"]);
    for (const id of ids) {
      const h = res.ttWf![id];
      expect(h.fWet.length).toBe(res.times.length);
      expect(h.rewetLatched.length).toBe(res.times.length);
      expect(h.regime.length).toBe(res.times.length);
      // Warm 300 K walls (≫ T_wet) initialize UNWETTED (memoryless init).
      expect(h.rewetLatched[0]).toBe(false);
      expect(h.fWet[0]).toBe(0);
      for (const f of h.fWet) {
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
    }
  }, 180000);
});

/* ============================================================================
 * TT-WF + fluid-front builder plumbing (Phase-3B evaluation enablement)
 *
 * Pins the PLUMBING of the `fluidFront: true` builder option
 * (docs/fluid-front-transport.md; Phase-3B trace evaluation):
 * every ttWf convection
 * conductor carries correlation.fluidFront: true, the inlet boundary node
 * carries fluidFrontInlet: 1 (the tracer source), the option is ttWf-only,
 * and a short solve records TransientResult.fluidFront histories aligned
 * 1:1 with times.  NO physics accuracy value is pinned here (no golden
 * RMSE/timing) — physics evaluation lives in the Phase-3B campaign.
 * ============================================================================ */
describe("buildChilldownTwoPhase fluidFront: true plumbing", () => {
  it("flags every ttWf conductor and marks the inlet boundary; leaves outlet unmarked", () => {
    const N = 3;
    const cfg = buildChilldownTwoPhase({
      segments: N,
      length: 60.96,
      correlationModel: "ttWf",
      outletWallCoupling: "upwind",
      fluidFront: true,
    });
    const convs = cfg.conductors!.filter((c) => c.type.kind === "convection");
    expect(convs.length).toBe(N + 1);
    for (const c of convs) {
      if (c.type.kind !== "convection") throw new Error("unreachable");
      expect(c.type.correlation!.model).toBe("ttWf");
      expect(c.type.correlation!.fluidFront).toBe(true);
      // TT-WF physical parameters stay unset (pre-registered defaults).
      expect(c.type.correlation!.frontEnergyFactor).toBeUndefined();
      expect(c.type.correlation!.rewetHysteresisOffsetK).toBeUndefined();
    }
    const f0 = cfg.nodes.find((n) => n.id === "f0")!;
    expect(f0.type).toBe("boundary");
    expect(f0.fluidFrontInlet).toBe(1);
    for (const n of cfg.nodes) {
      if (n.id !== "f0") expect(n.fluidFrontInlet).toBeUndefined();
    }
    // validate.ts accepts the gated config.
    expect(validateNetwork(cfg)).toEqual([]);
  });

  it("ttWf-only guard: fluidFront on a non-ttWf model throws at build time", () => {
    expect(() => buildChilldownTwoPhase({ fluidFront: true })).toThrow(
      /requires correlationModel 'ttWf'/,
    );
    expect(() =>
      buildChilldownTwoPhase({
        correlationModel: "darrHartwig",
        fluidFront: true,
      }),
    ).toThrow(/requires correlationModel 'ttWf'/);
  });

  it("default-preserving: omitting fluidFront sets no flag and no inlet marker", () => {
    const cfg = buildChilldownTwoPhase({
      segments: 2,
      length: 6,
      correlationModel: "ttWf",
    });
    for (const c of cfg.conductors!) {
      if (c.type.kind !== "convection") continue;
      expect(c.type.correlation!.fluidFront).toBeUndefined();
    }
    for (const n of cfg.nodes) expect(n.fluidFrontInlet).toBeUndefined();
  });

  it("a short gated solve converges and records 1:1-aligned front histories for the internal nodes", async () => {
    const cfg = buildChilldownTwoPhase({
      segments: 2,
      length: 6,
      drivingPressure: 0.5169e6,
      outletPressure: 101325,
      outletTemperature: 300,
      initialTemperature: 300,
      fluidName: "Nitrogen",
      outletWallCoupling: "upwind",
      correlationModel: "ttWf",
      fluidFront: true,
      dt: 2.5,
      endTime: 5,
      timeStepping: "fixed",
    });
    const res = await withTimeout(() => solveTransient(cfg), 120000);
    expect(res.converged).toBe(true);
    assertNoNaN(res);
    // Front histories exist for the INTERNAL fluid nodes only (f1 of N=2 —
    // f0/f2 are boundaries), aligned 1:1 with the accepted time grid.
    const ids = Object.keys(res.fluidFront ?? {}).sort();
    expect(ids).toEqual(["f1"]);
    for (const id of ids) {
      const h = res.fluidFront![id];
      expect(h.fraction.length).toBe(res.times.length);
      expect(h.fraction[0]).toBe(0); // warm-filled line at t = 0
      for (const a of h.fraction) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
      }
    }
    // TT-WF histories still record alongside.
    expect(Object.keys(res.ttWf ?? {}).sort()).toEqual([
      "conv0",
      "conv1",
      "conv2",
    ]);
  }, 180000);
});

/* ============================================================================
 * Regression: subcooled flashing must conserve energy (the parked-state bug)
 *
 * The subcooled 86.73 psia case is the one that parked on the pre-fix
 * solver: the trust-region-stalled Newton was falsely certified converged
 * and the trajectory froze at t≈120 s with a state that sustained ≈46 kW
 * of enthalpy-flux imbalance with ≈0 wall heat (215 % global energy
 * non-closure, station-4 threshold never crossed).
 *
 * Two invariants pin the fix so the bug cannot return silently:
 *   (a) per-step honest convergence — every step's scaled residual is below
 *       the tol*1e3 bar (pre-fix parked steps sat at ~1.3);
 *   (b) global energy conservation — |inlet enthalpy flux − outlet flux −
 *       wall heat − storage rate| closes within 12 % of the inlet flux over
 *       every one of the last 10 steps (pre-fix: 215 %).
 *
 * BOOKKEEPING (audited line-by-line against the solver's own energy rows,
 * solver.ts computeResidual, extended-system branch):
 *   - fluxes use the solver's upwind convention (outflowing fluid carries
 *     the UPWIND node's enthalpy; inlet enthalpy is taken PER STEP — the
 *     boundary state is constant here, but the per-step form is the correct
 *     one for scheduled boundaries);
 *   - the wall-heat sign follows the conductor convention: heatRate =
 *     G·(T_fluid − T_solid), so the heat INTO the fluid CV is −heatRate
 *     (the solver's Qconv = G·(T_solid − T_fluid));
 *   - the storage term is d(m·u)/dt with u = h − P/ρ, identical to the
 *     solver's formulation (m = ρ·V, V per builder);
 *   - the wall-heat sum covers only conductors attached to INTERNAL fluid
 *     nodes (conv1..3): conv0 heats the fixed-state inlet boundary node —
 *     the solver has no energy row for boundary nodes, so that heat never
 *     enters the fluid CV (it is a wall-side loss, ∫ ≈ −1.4 MJ over the
 *     run, and it is also why the legacy test-3 global accounting is not
 *     tighter than ~6 %).
 *
 * MEASURED on this case: worst per-step non-closure 9.66 % (dominated by
 * the t=110 s front-passage step; the trailing steps are 0.8–4.9 %),
 * energy-integrated 4.2 %.  This is a REAL solver finding, not bookkeeping:
 * the certified state of each step is converged against the PREVIOUS
 * outer-iteration's wall temperatures and relaxed film-coefficient map;
 * the wall re-solve and map update then perturb the raw-Watt energy rows
 * (≈0.7–9.4 kW here; fluid–wall G ≈ 8–25 kW/K, so a ≈0.05 K wall move
 * suffices) and nothing re-verifies the rows afterwards.  It is neither a
 * formulation inconsistency (halving dt shrinks the worst window residual
 * 9.66 % → 1.26 %; tightening tol 1e-5 → 1e-8 shrinks it 9.66 % → 4.88 % —
 * an inconsistency would be refinement-invariant) nor time-discretization
 * error (this audit measures distance to the discrete root, which is
 * refinement-independent at an exact solve).  Full mechanism analysis and
 * the coupled-gate prototype: the energy-certification finding.  The 12 %
 * bar is honest for the measured
 * artifact (24 % headroom) while retaining a ~18× margin against the
 * 215 % parked-state regression this test exists to catch; do NOT read it
 * as "energy closes to 12 %" — see the measured numbers above.
 * ============================================================================ */
describe("Subcooled flashing chilldown — energy-conservation invariant (regression)", () => {
  it("per-step convergence + global enthalpy balance closes within 12%", async () => {
    const Nsub = 3;
    const cfg = buildChilldownTwoPhase({
      segments: Nsub,
      length: 60.96,
      drivingPressure: 86.73 * 6894.757,
      outletPressure: 101325,
      outletTemperature: 300,
      initialTemperature: 300,
      inletTemperature: 76.0, // subcooled LN2 inlet (Table-6 −322.87 °F)
      outletWallCoupling: "upwind",
      dt: 10,
      endTime: 200,
      timeStepping: "fixed",
    });
    const res = await withTimeout(() => solveTransient(cfg), 240000);
    expect(res.aborted).toBeFalsy();
    expect(res.converged).toBe(true);
    assertNoNaN(res);

    // (a) per-step honest convergence (pre-fix parked steps: scaled ~1.3)
    expect(res.stepResidualsScaled).toBeDefined();
    const tol = cfg.settings.tolerance;
    const worstScaled = Math.max(...res.stepResidualsScaled!);
    expect(worstScaled).toBeLessThan(tol * 1e3);

    // (b) global energy balance over the last 10 steps, using the solver's
    // own per-node enthalpy traces (exact, not a (P,T,q) reconstruction).
    const steps = res.times.length;
    const segL = 60.96 / Nsub;
    const A_fluid = (Math.PI / 4) * Math.pow(0.015875, 2);
    const vol = A_fluid * segL;
    const dt = cfg.settings.dt!;
    const internalIds = cfg.nodes
      .filter((n) => n.type === "internal")
      .map((n) => n.id);
    const internalSet = new Set(internalIds);
    // Wall heat enters the fluid CV only through conductors attached to an
    // INTERNAL fluid node (see header; conv0 dumps heat into the fixed-state
    // inlet boundary reservoir and is excluded).
    const cvConds = cfg
      .conductors!.filter(
        (c) =>
          c.id.startsWith("conv") &&
          (internalSet.has(c.from) || internalSet.has(c.to)),
      )
      .map((c) => c.id);

    const hNode = (id: string, k: number): number => res.nodes[id].enthalpy![k];
    const uNode = (id: string, k: number): number =>
      hNode(id, k) - res.nodes[id].pressure[k] / res.nodes[id].density[k];

    let worstRel = 0;
    let worstK = 0;
    let imbEnergy = 0;
    let throughput = 0;
    for (let k = steps - 10; k < steps; k++) {
      const mdotIn = res.branches["pipe0"].mdot[k];
      const mdotOut = res.branches[`pipe${Nsub - 1}`].mdot[k];
      // Solver upwind convention for both boundary fluxes; per-step inlet h.
      const inFlux =
        mdotIn >= 0 ? mdotIn * hNode("f0", k) : mdotIn * hNode("f1", k);
      const outFlux =
        mdotOut >= 0
          ? mdotOut * hNode(`f${Nsub - 1}`, k)
          : mdotOut * hNode(`f${Nsub}`, k);
      let wallHeat = 0;
      for (const cid of cvConds) wallHeat += res.conductors![cid].heatRate[k];
      let storage = 0;
      for (const id of internalIds) {
        storage +=
          (res.nodes[id].density[k] * vol * uNode(id, k) -
            res.nodes[id].density[k - 1] * vol * uNode(id, k - 1)) /
          dt;
      }
      // Sign convention: heatRate = G·(T_fluid − T_solid) ⇒ heat INTO the
      // fluid CV is −wallHeat; balance is in − out + (−wall) − storage.
      const resid = inFlux - outFlux - wallHeat - storage;
      const rel = Math.abs(resid) / Math.max(Math.abs(inFlux), 1);
      if (rel > worstRel) {
        worstRel = rel;
        worstK = k;
      }
      imbEnergy += resid * dt;
      throughput += Math.abs(inFlux) * dt;
    }
    console.log(
      `subcooled energy closure: worst per-step non-closure = ${(worstRel * 100).toFixed(2)}% of inlet flux (t=${res.times[worstK]}s); energy-integrated = ${((Math.abs(imbEnergy) / Math.max(throughput, 1)) * 100).toFixed(2)}%`,
    );
    // Pre-fix parked state: 215 %.  Measured post-fix: 9.66 % worst step
    // (front-passage certification lag — see header), trailing steps
    // 0.8–4.9 %.  Bar: 12 %, honest for the measured artifact, ~18× margin
    // against the regression this test guards.  Do NOT tighten to 2 % until
    // the coupled-certification finding is
    // resolved at the solver level.
    expect(worstRel).toBeLessThan(0.12);

    // The parked state also never crossed the chilldown threshold: require
    // the downstream wall to actually chill (physics, not bookkeeping).
    const finalIdx = steps - 1;
    const TsatLocal = fluid.saturationTemperature(
      res.nodes[`f${Nsub - 1}`].pressure[finalIdx],
    );
    expect(res.solidNodes![`s${Nsub}`].temperature[finalIdx]).toBeLessThan(
      TsatLocal + 15,
    );
  }, 300000);
});
