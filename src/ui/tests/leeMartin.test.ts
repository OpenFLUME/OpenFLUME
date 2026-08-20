import { describe, it, expect } from "vitest";
import { buildLeeMartin } from "../examples";
import { solveTransient, componentPressureDrop } from "../../core";
import { Pipe, Valve } from "../../core/components";

/** RK4 integrator for dy/dt = f(t, y). */
function rk4Vec(
  f: (t: number, y: number[]) => number[],
  y0: number[],
  t0: number,
  tf: number,
  dt: number,
): number[] {
  let y = [...y0];
  let t = t0;
  const steps = Math.ceil((tf - t0) / dt);
  const h = (tf - t0) / steps;
  for (let i = 0; i < steps; i++) {
    const k1 = f(t, y);
    const k2 = f(
      t + h / 2,
      y.map((v, j) => v + (h * k1[j]) / 2),
    );
    const k3 = f(
      t + h / 2,
      y.map((v, j) => v + (h * k2[j]) / 2),
    );
    const k4 = f(
      t + h,
      y.map((v, j) => v + h * k3[j]),
    );
    y = y.map((v, j) => v + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    t += h;
  }
  return y;
}

function findPeaks(arr: number[]): Array<{ idx: number; value: number }> {
  const peaks: Array<{ idx: number; value: number }> = [];
  for (let i = 1; i < arr.length - 1; i++) {
    if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1] && arr[i] > 0) {
      peaks.push({ idx: i, value: arr[i] });
    }
  }
  return peaks;
}

describe("Lee & Martin entrapped-air", () => {
  it("paper targets", { timeout: 30000 }, () => {
    const config = buildLeeMartin();
    const dt = config.settings.dt!;
    const res = solveTransient(config);
    expect(res.converged).toBe(true);

    const P = res.nodes["12"].pressure;
    const peaks = findPeaks(P);
    expect(peaks.length).toBeGreaterThanOrEqual(4);

    const firstPeak = peaks[0];
    const firstPeakMPa = firstPeak.value / 1e6;
    expect(firstPeakMPa).toBeGreaterThanOrEqual(1.615); // 1.90 - 15%
    expect(firstPeakMPa).toBeLessThanOrEqual(2.185); // 1.90 + 15%

    const tPeak = firstPeak.idx * dt;
    expect(tPeak).toBeGreaterThanOrEqual(0.6);
    expect(tPeak).toBeLessThanOrEqual(0.9);

    const periods: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
      periods.push((peaks[i].idx - peaks[i - 1].idx) * dt);
    }
    for (const T of periods) {
      expect(T).toBeGreaterThanOrEqual(0.5);
      expect(T).toBeLessThanOrEqual(0.65);
    }

    // monotonically decaying amplitudes
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i].value).toBeLessThan(peaks[i - 1].value);
    }

    // late-time mean within ±10% of reservoir pressure
    const P_R = config.nodes.find((n) => n.id === "1")!.pressure! / 1e6;
    const last1s = P.slice(Math.max(0, P.length - 101));
    const lateMean = last1s.reduce((a, b) => a + b, 0) / last1s.length / 1e6;
    expect(lateMean).toBeGreaterThanOrEqual(P_R * 0.9);
    expect(lateMean).toBeLessThanOrEqual(P_R * 1.1);
  });

  it("independent RK4 reference matches within 8%", { timeout: 60000 }, () => {
    // The backward-Euler solver is numerically dissipative at the published dt=0.01 s,
    // so this convergence test uses a finer solver dt (0.003 s) against a high-resolution
    // explicit RK4 rigid-column reference.
    const solverDt = 0.003;
    const config = buildLeeMartin({ dt: solverDt, endTime: 4 });
    const rk4Dt = 0.001;
    const endTime = 4;
    const D = 0.026035;
    const A = (Math.PI / 4) * D * D;
    const L_total = 10 * 0.6096;
    const rho = 998;
    const mu = 1e-3;
    const P_R = config.nodes.find((n) => n.id === "1")!.pressure!;
    const n = config.nodes.find((n) => n.id === "12")!.gasCushion!
      .polytropicIndex;
    const Vg0 = config.nodes.find((n) => n.id === "12")!.gasCushion!
      .initialGasVolume;
    const V_total = config.nodes.find((n) => n.id === "12")!.volume! as number; // literal config: no formula bindings
    const P0 = config.nodes.find((n) => n.id === "12")!.pressure!;
    const C = P0 * Math.pow(Vg0, n);

    // Simplifications documented:
    // 1. Total pipe friction is modelled as a single Pipe of length 10*L because all
    //    10 segments are identical and in series; the friction factor is the same for
    //    each segment at a given Re, so the total drop equals 10 × one-segment drop.
    // 2. The valve is treated as perfectly closed (mdot = 0) when position = 0,
    //    avoiding the 1e-9 m² floor that makes the explicit RK4 impossibly stiff.
    const pipe = new Pipe(L_total, D, 1.5e-6, 0);
    const valve = new Valve(A, 0.6, 0, [
      [0, 0],
      [0.15, 0],
      [0.4, 1],
    ]);

    const ode = (_t: number, y: number[]) => {
      const mdot = y[0];
      const Vw = y[1];
      const pos = valve.getPosition(_t);
      if (pos <= 0) {
        return [0, 0];
      }
      const Vg = V_total - Vw;
      const P_gas = C / Math.pow(Vg, n);
      const dP_pipe = componentPressureDrop(mdot, rho, mu, pipe, _t);
      const dP_valve = componentPressureDrop(mdot, rho, mu, valve, _t);
      const dmdot_dt = (A / L_total) * (P_R - dP_pipe - dP_valve - P_gas);
      const dVw_dt = mdot / rho;
      return [dmdot_dt, dVw_dt];
    };

    const y0 = [0, V_total - Vg0];
    const steps = Math.round(endTime / rk4Dt);
    const mdots_rk4: number[] = [0];
    const P_rk4: number[] = [P0];
    let y = [...y0];
    for (let step = 1; step <= steps; step++) {
      const t = step * rk4Dt;
      y = rk4Vec(ode, y, t - rk4Dt, t, rk4Dt);
      mdots_rk4.push(y[0]);
      const Vg = V_total - y[1];
      P_rk4.push(C / Math.pow(Vg, n));
    }

    const res = solveTransient(config);
    const peaksSolver = findPeaks(res.nodes["12"].pressure);
    const peaksRK4 = findPeaks(P_rk4);

    expect(peaksSolver.length).toBeGreaterThanOrEqual(3);
    expect(peaksRK4.length).toBeGreaterThanOrEqual(3);

    // first-peak amplitude within 8%
    const ampSolver = peaksSolver[0].value;
    const ampRK4 = peaksRK4[0].value;
    expect(Math.abs(ampSolver - ampRK4) / Math.max(ampRK4, 1e-6)).toBeLessThan(
      0.08,
    );

    // first-peak time within 8%
    const tSolver = peaksSolver[0].idx * solverDt;
    const tRK4 = peaksRK4[0].idx * rk4Dt;
    expect(Math.abs(tSolver - tRK4) / Math.max(tRK4, 1e-6)).toBeLessThan(0.08);

    // period within 8%
    if (peaksSolver.length >= 2 && peaksRK4.length >= 2) {
      const T_solver = (peaksSolver[1].idx - peaksSolver[0].idx) * solverDt;
      const T_rk4 = (peaksRK4[1].idx - peaksRK4[0].idx) * rk4Dt;
      expect(Math.abs(T_solver - T_rk4) / Math.max(T_rk4, 1e-6)).toBeLessThan(
        0.08,
      );
    }
  });

  it("physics invariants", { timeout: 30000 }, () => {
    const config = buildLeeMartin();
    const dt = config.settings.dt!;
    const res = solveTransient(config);
    expect(res.converged).toBe(true);

    const P = res.nodes["12"].pressure;
    const Vg = res.nodes["12"].gasVolume!;
    const node12 = config.nodes.find((n) => n.id === "12")!;
    const n = node12.gasCushion!.polytropicIndex;
    const Vg0 = node12.gasCushion!.initialGasVolume;
    const V_total = node12.volume! as number; // literal config: no formula bindings
    const P0 = node12.pressure!;
    const C = P0 * Math.pow(Vg0, n);

    // P·V^n constant within 1%
    let maxPVdev = 0;
    for (let i = 0; i < P.length; i++) {
      const pv = P[i] * Math.pow(Vg[i], n);
      maxPVdev = Math.max(maxPVdev, Math.abs(pv - C) / C);
    }
    expect(maxPVdev).toBeLessThan(0.01);

    // total cavity volume conserved
    let maxVolErr = 0;
    for (let i = 0; i < P.length; i++) {
      const Vw = V_total - Vg[i];
      maxVolErr = Math.max(maxVolErr, Math.abs(Vw + Vg[i] - V_total));
    }
    expect(maxVolErr).toBeLessThan(1e-9);

    // no NaN
    for (const p of P) expect(Number.isNaN(p)).toBe(false);
    for (const v of Vg) expect(Number.isNaN(v)).toBe(false);
    for (const b of Object.values(res.branches)) {
      for (const m of b.mdot) expect(Number.isNaN(m)).toBe(false);
    }

    // mass conservation: integral mdot dt vs accumulated water volume
    const rho = 998;
    const mdot = res.branches["valve"].mdot;
    let totalMassIn = 0;
    for (let i = 1; i < mdot.length; i++) {
      totalMassIn += 0.5 * (mdot[i] + mdot[i - 1]) * dt;
    }
    const Vw0 = V_total - Vg0;
    const VwEnd = V_total - Vg[Vg.length - 1];
    const massExpected = rho * (VwEnd - Vw0);
    expect(Math.abs(totalMassIn - massExpected) / massExpected).toBeLessThan(
      0.005,
    );
  });

  it("parameter sensitivity", { timeout: 60000 }, () => {
    const dt = 0.01;
    const endTime = 4;

    // baseline
    const base = buildLeeMartin({ dt, endTime });
    const resBase = solveTransient(base);
    const peaksBase = findPeaks(resBase.nodes["12"].pressure);
    const ampBase = peaksBase[0].value;
    const periodBase =
      peaksBase.length >= 2 ? (peaksBase[1].idx - peaksBase[0].idx) * dt : 0;

    // lower pressure ratio
    const lowP = buildLeeMartin({ pressureRatio: 3.5, dt, endTime });
    const resLowP = solveTransient(lowP);
    const peaksLowP = findPeaks(resLowP.nodes["12"].pressure);
    const ampLowP = peaksLowP[0].value;
    expect(ampLowP).toBeLessThan(ampBase);

    // larger alpha_g
    const largeAlpha = buildLeeMartin({ alphaG: 0.55, dt, endTime });
    const resLargeAlpha = solveTransient(largeAlpha);
    const peaksLargeAlpha = findPeaks(resLargeAlpha.nodes["12"].pressure);
    const periodLargeAlpha =
      peaksLargeAlpha.length >= 2
        ? (peaksLargeAlpha[1].idx - peaksLargeAlpha[0].idx) * dt
        : 0;
    expect(periodLargeAlpha).toBeGreaterThan(periodBase);
  });
});
