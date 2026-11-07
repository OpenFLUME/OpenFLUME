/**
 * GFSSP-grounded conjugate thermal-fluid benchmark tests (transient end-state validation)
 *
 * Sources cited:
 *   A — NASA/TM-2013-217492 §6.13 (Example 11, §5.11 of the v5 Educational
 *       manual, NASA/TM-2011-216470) + Majumdar TFAWS-2004
 *   B — JANNAF-2024 Majumdar & LeClair conjugate HX schematic
 *   C — GFSSP v5 manual Example 5 via Patel 2011
 *
 * Reference types (scripts/benchmarks-report.ts reports the achieved values):
 *   A is gated against the ANALYTIC fin solution (analytic verification);
 *   B's duty against ε-NTU (analytic), its outlet temperatures against the
 *   published GFSSP values; C against GFSSP's published output.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { solveSteady, solveTransient } from "../../core";
import {
  gfsspEx13ConductionRod,
  gfsspN2N2CounterflowHX,
  gfsspEx5WaterWaterHX,
} from "../examples";
import type { NetworkConfig, TransientResult } from "../types";

/* ============================================================================
 * Helpers
 * ============================================================================ */

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function buildSteadyConfig(config: NetworkConfig): NetworkConfig {
  const clone: NetworkConfig = JSON.parse(JSON.stringify(config));
  clone.settings = {
    ...clone.settings,
    mode: "steady",
  };
  delete (clone.settings as any).dt;
  delete (clone.settings as any).endTime;
  return clone;
}

/**
 * Inverse of buildSteadyConfig: build a transient copy of a config that
 * ships in steady mode (Benchmark C — the shipped Ex.5 example is steady;
 * the transient assertions below exercise the same physics through the
 * transient integrator).  dt/endTime are retained from the source settings.
 */
function buildTransientConfig(config: NetworkConfig): NetworkConfig {
  const clone: NetworkConfig = JSON.parse(JSON.stringify(config));
  clone.settings = {
    ...clone.settings,
    mode: "transient",
  };
  return clone;
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
  for (const cd of Object.values(res.conductors ?? {})) {
    expect(cd.heatRate.some(isNaN)).toBe(false);
  }
}

function assertSteadiness(trace: number[], label: string) {
  const n = trace.length;
  const startIdx = Math.floor(n * 0.9);
  const slice = trace.slice(startIdx);
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variation = Math.abs(max - min) / avg;
  expect(variation, `${label} did not reach steady state`).toBeLessThan(0.005); // < 0.5 %
}

function assertMonotoneIncrease(trace: number[]) {
  for (let i = 1; i < trace.length; i++) {
    expect(trace[i]).toBeGreaterThanOrEqual(trace[i - 1] - 1e-9);
  }
}

/* ============================================================================
 * Benchmark A — GFSSP Ex.13: Conduction rod with convection
 * ============================================================================ */
describe("Benchmark A — GFSSP Ex.13: Conduction rod with convection", () => {
  const config = gfsspEx13ConductionRod;

  function analyticalT(x_ft: number): number {
    const Tinf_F = 70;
    const T_F =
      Tinf_F + 4.653 * Math.exp(1.714 * x_ft) - 42.65 * Math.exp(-1.714 * x_ft);
    return ((T_F - 32) * 5) / 9 + 273.15;
  }

  let res: TransientResult;
  let steadyRes: ReturnType<typeof solveSteady>;

  beforeAll(() => {
    res = solveTransient(config);
    steadyRes = solveSteady(buildSteadyConfig(config));
  });

  it("converges with no NaN", () => {
    expect(res.converged).toBe(true);
    assertNoNaN(res);
  });

  it("interior solid-node end-state temperatures match analytical within 3.0 K (N=5)", () => {
    const L = 0.6096;
    const N = 5;
    const devs: number[] = [];
    for (let i = 0; i < N; i++) {
      const x_m = ((i + 0.5) * L) / N;
      const x_ft = x_m / 0.3048;
      const T_num = last(res.solidNodes![`s${i}`].temperature);
      const T_ana = analyticalT(x_ft);
      devs.push(T_num - T_ana);
    }
    // Achieved values are logged so the report (scripts/benchmarks-report.ts)
    // and the CI log show the agreement, not only the pass band.
    console.log(
      `Benchmark A: T_num − T_analytic = ${devs.map((d) => d.toFixed(2)).join(", ")} K (max |Δ| ${Math.max(...devs.map(Math.abs)).toFixed(2)} K; gate 3.0 K)`,
    );
    for (const d of devs) expect(Math.abs(d)).toBeLessThanOrEqual(3.0);
  });

  it("center node (s2) end-state ≈ 304.4 K", () => {
    expect(last(res.solidNodes!["s2"].temperature)).toBeCloseTo(304.4, 0);
  });

  it("end-adjacent conduction heat flows at end-state within 7% of analytical", () => {
    const k = 16.27;
    const A = 2.028e-3;
    const dTdx_cold = 81.08;
    const dTdx_hot = 248.2;
    const conv = (f: number) => (f * 5) / 9 / 0.3048;
    const Q_cold_ana = -k * A * conv(dTdx_cold);
    const Q_hot_ana = -k * A * conv(dTdx_hot);
    const Q_cold_num = last(res.conductors!["c_cold_s0"].heatRate);
    const Q_hot_num = last(res.conductors!["c_s4_hot"].heatRate);
    const errCold =
      Math.abs(-Q_cold_num - Math.abs(Q_cold_ana)) / Math.abs(Q_cold_ana);
    const errHot =
      Math.abs(-Q_hot_num - Math.abs(Q_hot_ana)) / Math.abs(Q_hot_ana);
    console.log(
      `Benchmark A: end heat flows vs analytic: cold ${(errCold * 100).toFixed(2)} %, hot ${(errHot * 100).toFixed(2)} % (gate 7 %)`,
    );
    expect(errCold).toBeLessThan(0.07);
    expect(errHot).toBeLessThan(0.07);
  });

  it("global energy balance at end-state within 0.5%", () => {
    const Q_cold = -last(res.conductors!["c_cold_s0"].heatRate);
    const Q_hot = -last(res.conductors!["c_s4_hot"].heatRate);
    let Q_conv = 0;
    for (let i = 0; i < 5; i++) {
      Q_conv += last(res.conductors![`c_s${i}_air`].heatRate);
    }
    const imbalance = Math.abs(Q_hot - (Q_cold + Q_conv)) / Q_hot;
    console.log(
      `Benchmark A: global energy imbalance ${(imbalance * 100).toExponential(2)} % (gate 0.5 %)`,
    );
    expect(imbalance).toBeLessThan(0.005);
  });

  it("air stream end-state temperature rise < 0.05 K", () => {
    const dT = last(res.nodes["air_mid"].temperature) - 294.26;
    expect(Math.abs(dT)).toBeLessThan(0.05);
  });

  it("steadiness: last 10% of monitored traces vary < 0.5%", () => {
    for (let i = 0; i < 5; i++) {
      assertSteadiness(res.solidNodes![`s${i}`].temperature, `s${i}`);
    }
    assertSteadiness(res.nodes["air_mid"].temperature, "air_mid");
  });

  it("monotone warm-up of representative wall temperature (s2)", () => {
    assertMonotoneIncrease(res.solidNodes!["s2"].temperature);
  });

  it("cross-check: transient end-state matches steady-mode solve within 0.5% on solid temperatures", () => {
    for (let i = 0; i < 5; i++) {
      const id = `s${i}`;
      const Tt = last(res.solidNodes![id].temperature);
      const Ts = steadyRes.solidNodes![id].temperature;
      expect(Math.abs(Tt - Ts) / Ts).toBeLessThan(0.005);
    }
  });
});

/* ============================================================================
 * Benchmark B — GFSSP-style N2–N2 counterflow HX (conjugate)
 * ============================================================================ */
describe("Benchmark B — GFSSP-style N2-N2 counterflow HX", () => {
  const config = gfsspN2N2CounterflowHX;

  let res: TransientResult;
  let steadyRes: ReturnType<typeof solveSteady>;

  beforeAll(() => {
    res = solveTransient(config);
    steadyRes = solveSteady(buildSteadyConfig(config));
  });

  it("converges with no NaN", () => {
    expect(res.converged).toBe(true);
    assertNoNaN(res);
  });

  it("solver end-state duty within 5% of ε-NTU reference", () => {
    const cp = 1040;
    const mdot_h = 1.175;
    const mdot_c = 1.193;
    const Th_in = 394.26;
    const Tc_in = 294.26;
    const Th_out = last(res.nodes["h5"].temperature);
    const Q_solver = mdot_h * cp * (Th_in - Th_out);

    const Nseg = 5;
    const h_h = 970;
    const h_c = 1250;
    const A_i = (Math.PI * 0.0508 * 0.6096) / Nseg;
    const A_o = (Math.PI * 0.05715 * 0.6096) / Nseg;
    const UA_seg = 1 / (1 / (h_h * A_i) + 1 / (h_c * A_o));
    const UA_total = Nseg * UA_seg;
    const C_h = mdot_h * cp;
    const C_c = mdot_c * cp;
    const C_min = Math.min(C_h, C_c);
    const C_r = C_min / Math.max(C_h, C_c);
    const NTU = UA_total / C_min;
    const eps =
      (1 - Math.exp(-NTU * (1 - C_r))) / (1 - C_r * Math.exp(-NTU * (1 - C_r)));
    const Q_ntu = eps * C_min * (Th_in - Tc_in);

    const gap = Math.abs(Q_solver - Q_ntu) / Q_ntu;
    console.log(
      `Benchmark B: Q_solver=${Q_solver.toFixed(1)} W, Q_ntu=${Q_ntu.toFixed(1)} W, gap=${(gap * 100).toFixed(2)}%`,
    );
    expect(gap).toBeLessThan(0.05);
  });

  it("hot-out ≈ 390.3 K and cold-out ≈ 298.2 K within 2.5 K at end-state", () => {
    const Th = last(res.nodes["h5"].temperature);
    const Tc = last(res.nodes["c1"].temperature);
    console.log(
      `Benchmark B: Th_out=${Th.toFixed(2)} K (GFSSP 390.3 K, Δ ${(Th - 390.3).toFixed(2)} K), Tc_out=${Tc.toFixed(2)} K (GFSSP 298.2 K, Δ ${(Tc - 298.2).toFixed(2)} K); gate 2.5 K`,
    );
    expect(Math.abs(Th - 390.3)).toBeLessThan(2.5);
    expect(Math.abs(Tc - 298.2)).toBeLessThan(2.5);
  });

  it("energy balance hot vs cold duty at end-state within 1%", () => {
    const cp = 1040;
    const Q_h = 1.175 * cp * (394.26 - last(res.nodes["h5"].temperature));
    const Q_c = 1.193 * cp * (last(res.nodes["c1"].temperature) - 294.26);
    const imbalance =
      Math.abs(Q_h - Q_c) / Math.max(Math.abs(Q_h), Math.abs(Q_c));
    console.log(
      `Benchmark B: hot/cold duty imbalance ${(imbalance * 100).toFixed(3)} % (gate 1 %)`,
    );
    expect(imbalance).toBeLessThan(0.01);
  });

  it("end-state wall temperatures are monotonic between hot and cold fluid temps", () => {
    const wallIds = ["w1", "w2", "w3", "w4", "w5"];
    for (let i = 0; i < wallIds.length - 1; i++) {
      const Tw_i = last(res.solidNodes![wallIds[i]].temperature);
      const Tw_next = last(res.solidNodes![wallIds[i + 1]].temperature);
      expect(Tw_i).toBeGreaterThanOrEqual(Tw_next - 0.01);
    }
    for (let i = 1; i <= 5; i++) {
      const Th = last(res.nodes[`h${i}`].temperature);
      const Tw = last(res.solidNodes![`w${i}`].temperature);
      const Tc = last(res.nodes[`c${i}`].temperature);
      expect(Tw).toBeGreaterThanOrEqual(Math.min(Th, Tc) - 0.01);
      expect(Tw).toBeLessThanOrEqual(Math.max(Th, Tc) + 0.01);
    }
  });

  it("steadiness: last 10% of monitored traces vary < 0.5%", () => {
    assertSteadiness(res.nodes["h5"].temperature, "h5");
    assertSteadiness(res.nodes["c1"].temperature, "c1");
    for (const wid of ["w1", "w2", "w3", "w4", "w5"]) {
      assertSteadiness(res.solidNodes![wid].temperature, wid);
    }
  });

  it("monotone warm-up of representative wall temperature (w3)", () => {
    assertMonotoneIncrease(res.solidNodes!["w3"].temperature);
  });

  it("cross-check: transient end-state matches steady-mode solve within 0.5% on key temperatures", () => {
    const keyIds = ["h5", "c1", "w1", "w2", "w3", "w4", "w5"];
    for (const id of keyIds) {
      const Tt = id.startsWith("w")
        ? last(res.solidNodes![id].temperature)
        : last(res.nodes[id].temperature);
      const Ts = id.startsWith("w")
        ? steadyRes.solidNodes![id].temperature
        : steadyRes.nodes[id].temperature;
      expect(Math.abs(Tt - Ts) / Ts).toBeLessThan(0.005);
    }
  });
});

/* ============================================================================
 * Benchmark C — GFSSP Ex.5: water-water counterflow HX
 * ============================================================================ */
describe("Benchmark C — GFSSP Ex.5: water-water counterflow HX", () => {
  function buildHX(nSeg: number): NetworkConfig {
    const UA_total = 2094;
    const mdot_h = 0.4014;
    const mdot_c = 2.454;
    const Th_in = 310.93;
    const Tc_in = 288.71;
    const G_side = (2 * UA_total) / nSeg;

    const nodes: NetworkConfig["nodes"] = [];
    const solidNodes: NetworkConfig["solidNodes"] = [];
    const conductors: NetworkConfig["conductors"] = [];
    const branches: NetworkConfig["branches"] = [];

    nodes.push({
      id: "h_in",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: 2e5,
      temperature: Th_in,
    });
    nodes.push({
      id: "h_out",
      type: "boundary",
      x: (nSeg + 1) * 70,
      y: 0,
      pressure: 2e5,
      temperature: Th_in,
    });
    nodes.push({
      id: "c_in",
      type: "boundary",
      x: (nSeg + 1) * 70,
      y: 200,
      pressure: 2e5,
      temperature: Tc_in,
    });
    nodes.push({
      id: "c_out",
      type: "boundary",
      x: 0,
      y: 200,
      pressure: 2e5,
      temperature: Tc_in,
    });

    for (let i = 1; i <= nSeg; i++) {
      nodes.push({
        id: `h${i}`,
        type: "internal",
        x: i * 70,
        y: 0,
        pressure: 2e5,
        temperature: Th_in,
      });
      nodes.push({
        id: `c${i}`,
        type: "internal",
        x: i * 70,
        y: 200,
        pressure: 2e5,
        temperature: Tc_in,
      });
      solidNodes.push({
        id: `w${i}`,
        type: "solid",
        x: i * 70,
        y: 100,
        temperature: 300,
        mass: 0.1,
        cp: 500,
      });
      conductors.push({
        id: `hw${i}`,
        from: `h${i}`,
        to: `w${i}`,
        type: { kind: "convection", h: G_side, area: 1 },
      });
      conductors.push({
        id: `cw${i}`,
        from: `w${i}`,
        to: `c${i}`,
        type: { kind: "convection", h: G_side, area: 1 },
      });
    }

    branches.push({
      id: "hb0",
      from: "h_in",
      to: "h1",
      component: { type: "flowSource", massFlow: mdot_h },
    });
    for (let i = 1; i < nSeg; i++) {
      branches.push({
        id: `hb${i}`,
        from: `h${i}`,
        to: `h${i + 1}`,
        component: { type: "flowSource", massFlow: mdot_h },
      });
    }
    branches.push({
      id: `hb${nSeg}`,
      from: `h${nSeg}`,
      to: "h_out",
      component: { type: "flowSource", massFlow: mdot_h },
    });

    branches.push({
      id: "cb0",
      from: "c_in",
      to: `c${nSeg}`,
      component: { type: "flowSource", massFlow: mdot_c },
    });
    for (let i = nSeg; i >= 2; i--) {
      branches.push({
        id: `cb${nSeg - i + 1}`,
        from: `c${i}`,
        to: `c${i - 1}`,
        component: { type: "flowSource", massFlow: mdot_c },
      });
    }
    branches.push({
      id: `cb${nSeg}`,
      from: "c1",
      to: "c_out",
      component: { type: "flowSource", massFlow: mdot_c },
    });

    return {
      meta: { name: `GFSSP Ex.5 HX N=${nSeg}`, version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-8,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes,
      solidNodes,
      conductors,
      branches,
    };
  }

  const config = gfsspEx5WaterWaterHX;

  let res: TransientResult;
  let steadyRes: ReturnType<typeof solveSteady>;

  beforeAll(() => {
    // The shipped Ex.5 example runs in steady mode; the transient variant
    // (same physics, dt/endTime carried over from the shipped settings)
    // provides the end-state the transient assertions below check.
    res = solveTransient(buildTransientConfig(config));
    steadyRes = solveSteady(buildSteadyConfig(config));
  });

  it("converges with no NaN", () => {
    expect(res.converged).toBe(true);
    assertNoNaN(res);
  });

  it("T_hot,out end-state = 295.67 K ± 1.0 K", () => {
    const Th_out = last(res.nodes["h12"].temperature);
    console.log(
      `Benchmark C N=12: Th_out=${Th_out.toFixed(2)} K (GFSSP 295.67 K, Δ ${(Th_out - 295.67).toFixed(2)} K; gate 1.0 K)`,
    );
    expect(Math.abs(Th_out - 295.67)).toBeLessThan(1.0);
  });

  it("T_cold,out end-state = 290.94 K ± 0.5 K", () => {
    const Tc_out = last(res.nodes["c1"].temperature);
    console.log(
      `Benchmark C N=12: Tc_out=${Tc_out.toFixed(2)} K (GFSSP 290.94 K, Δ ${(Tc_out - 290.94).toFixed(2)} K; gate 0.5 K)`,
    );
    expect(Math.abs(Tc_out - 290.94)).toBeLessThan(0.5);
  });

  it("duty end-state ≈ 25.6 kW within 3%", () => {
    const cp = 4182;
    const Q = 0.4014 * cp * (310.93 - last(res.nodes["h12"].temperature));
    console.log(
      `Benchmark C N=12: Q=${(Q / 1000).toFixed(2)} kW (GFSSP 25.6 kW, ${(((Q - 25600) / 25600) * 100).toFixed(2)} %; gate 3 %)`,
    );
    expect(Math.abs(Q - 25600) / 25600).toBeLessThan(0.03);
  });

  it("hot/cold duty balance at end-state within 0.5%", () => {
    const cp = 4182;
    const Q_h = 0.4014 * cp * (310.93 - last(res.nodes["h12"].temperature));
    const Q_c = 2.454 * cp * (last(res.nodes["c1"].temperature) - 288.71);
    expect(
      Math.abs(Q_h - Q_c) / Math.max(Math.abs(Q_h), Math.abs(Q_c)),
    ).toBeLessThan(0.005);
  });

  it("steadiness: last 10% of monitored traces vary < 0.5%", () => {
    assertSteadiness(res.nodes["h12"].temperature, "h12");
    assertSteadiness(res.nodes["c1"].temperature, "c1");
    for (let i = 1; i <= 12; i++) {
      assertSteadiness(res.solidNodes![`w${i}`].temperature, `w${i}`);
    }
  });

  it("monotone warm-up of representative wall temperature (w6)", () => {
    assertMonotoneIncrease(res.solidNodes!["w6"].temperature);
  });

  it("cross-check: transient end-state matches steady-mode solve within 0.5% on key temperatures", () => {
    const keyIds = ["h12", "c1"];
    for (let i = 1; i <= 12; i++) keyIds.push(`w${i}`);
    for (const id of keyIds) {
      const Tt = id.startsWith("w")
        ? last(res.solidNodes![id].temperature)
        : last(res.nodes[id].temperature);
      const Ts = id.startsWith("w")
        ? steadyRes.solidNodes![id].temperature
        : steadyRes.nodes[id].temperature;
      expect(Math.abs(Tt - Ts) / Ts).toBeLessThan(0.005);
    }
  });

  // Grid-convergence is kept in steady mode because running three separate
  // transient solves (N=4,8,12) would be slow and adds no transient-specific
  // insight; the test only verifies spatial discretization trends.
  it("grid convergence: increasing segments 4→8→12 moves outlets toward published values", () => {
    const res4 = solveSteady(buildHX(4));
    const res8 = solveSteady(buildHX(8));
    const res12 = solveSteady(buildHX(12));

    expect(res4.converged).toBe(true);
    expect(res8.converged).toBe(true);
    expect(res12.converged).toBe(true);

    const Th4 = res4.nodes["h4"].temperature;
    const Th8 = res8.nodes["h8"].temperature;
    const Th12 = res12.nodes["h12"].temperature;

    const Tc4 = res4.nodes["c1"].temperature;
    const Tc8 = res8.nodes["c1"].temperature;
    const Tc12 = res12.nodes["c1"].temperature;

    // Hot outlet should decrease toward 295.67 K
    expect(Th8).toBeLessThan(Th4);
    expect(Th12).toBeLessThan(Th8);

    // Cold outlet should increase toward 290.94 K
    expect(Tc8).toBeGreaterThan(Tc4);
    expect(Tc12).toBeGreaterThan(Tc8);

    console.log(
      `Grid conv: N=4 Th=${Th4.toFixed(2)} Tc=${Tc4.toFixed(2)} | N=8 Th=${Th8.toFixed(2)} Tc=${Tc8.toFixed(2)} | N=12 Th=${Th12.toFixed(2)} Tc=${Tc12.toFixed(2)}`,
    );
  });
});
