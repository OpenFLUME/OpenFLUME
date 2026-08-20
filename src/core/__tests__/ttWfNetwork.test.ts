/**
 * TT-WF (two-temperature / wetted-fraction) proposed chilldown closure —
 * Phase-2 NETWORK-level integration tests.
 *
 * Where ttWf.test.ts proves the local algebra (pure evaluator), this file
 * proves the SOLVER/CONDUCTOR lifecycle contract of the integration:
 *
 *  1. ACCEPTED-STEP IMMUTABILITY — an adaptive run with rejected
 *     step-doubling trials: the recorded fWet/latch history is replayed
 *     EXACTLY by re-evaluating the pure closure once per accepted step from
 *     the recorded accepted states (inputs at t_{k+1}, accepted state at
 *     t_k, accepted dt).  Any commit during a Newton iteration or a rejected
 *     trial would break this replay equality.  The latch-transition
 *     diagnostic counters must equal the transitions visible in the
 *     recorded history (a mid-iteration commit would inflate them).
 *  2. ENERGY CONSERVATION — global fluid+solid energy audit of a 3-segment
 *     LH2 chilldown line, computed independently from the recorded series
 *     (NOT from solver residuals), plus a per-conductor local wall-energy
 *     audit.
 *  3. FRONT ORDERING / MORPHOLOGY — warm line, cold saturated-liquid
 *     inlet: latch set and fWet progression must be ordered inlet → outlet.
 *     A Darr–Hartwig run on the same network is a QUALITATIVE structural
 *     comparison only (ordering concordance; no magnitudes, no fitting).
 *  4. HYSTERESIS AT NETWORK SCALE — a warm/cold/warm inlet-temperature
 *     cycle produces exactly one latch set and one latch clear, monotone
 *     fWet while latched, and no per-iteration chatter (counter/history
 *     equality).
 *  5. BACKWARD COMPATIBILITY — a network without ttWf conductors carries
 *     no TransientResult.ttWf field; existing golden suites cover the
 *     bit-identity of the other models.
 *  6. DIAGNOSTICS — ttWf counters zero or explainable; no safeStatePH
 *     last-resort; no h-floor clamp unless the test explicitly triggers it.
 *
 * Fixture: LH2 (para-hydrogen) line, D = 1.02 cm (D-H tube), P_in = 2.5 bar
 * saturated liquid, P_out = 2.0 bar warm vapor, thin-wall copper tube
 * (OD 12.7 mm), 1 m segments — inside/near the D-H fit envelope, and the
 * line is short enough to keep the suite fast.  All numbers below are
 * measured on THIS solver; tolerances are justified inline where asserted.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  initRealFluids,
  realFluidsReady,
  RealFluid,
  clampToValidPH,
} from "../";
import { getFluidLimits } from "../fluids/realFluid";
import { solveTransient } from "../transient";
import {
  getSolverDiagnostics,
  resetSolverDiagnostics,
  type SolverDiagnostics,
} from "../diagnostics";
import { evaluateTtWf, type TtWfState } from "../ttWf";
import type { DHSatState, DHVaporProps } from "../darrHartwig";
import type { NetworkConfig, TransientResult, Conductor } from "../schema";

/* =============================================================================
 * Shared fixture / config builder
 * ============================================================================= */
const D = 0.0102; // m, D-H tube ID
const A_FLUID = (Math.PI / 4) * D * D;
const OD = 0.0127; // m, thin-wall tube
const RHO_CU = 8960;
const CP_CU = 385; // constant cp (the audit uses the same analytic enthalpy)
const A_METAL = (Math.PI / 4) * (OD * OD - D * D);
const SEG_L = 1.0; // m per axial segment
const P_IN = 2.5e5;
const P_OUT = 2e5;
const T_WALL0 = 300;
const M_SEG = RHO_CU * A_METAL * SEG_L; // wall mass per segment [kg]
const VOL = A_FLUID * SEG_L; // fluid volume per internal node [m³]

let fluid: RealFluid;

function buildLine(opts: {
  nSeg: number;
  model?: "ttWf" | "darrHartwig" | "miropolskii";
  endTime: number;
  dt?: number;
  adaptive?: {
    dtInitial: number;
    dtMin: number;
    dtMax: number;
    relTol: number;
  };
  inletSchedule?: Array<[number, number]>;
  wallT0?: number;
}): NetworkConfig {
  const N = opts.nSeg;
  const nodes: NetworkConfig["nodes"] = [];
  const solidNodes: NetworkConfig["solidNodes"] = [];
  const inlet: NetworkConfig["nodes"][number] = {
    id: "f0",
    type: "boundary",
    x: 0,
    y: 0,
    pressure: P_IN,
    quality: 0,
  };
  if (opts.inletSchedule) {
    delete (inlet as { quality?: number }).quality;
    inlet.temperature = opts.inletSchedule[0][1];
    inlet.temperatureSchedule = opts.inletSchedule;
  }
  nodes.push(inlet);
  for (let i = 1; i <= N; i++) {
    const p0 = P_IN - ((P_IN - P_OUT) * i) / (N + 1);
    // Saturated-VAPOR initial line (pre-evacuated/backfilled): keeps the t=0
    // state off the hot wall / hot vapor overlap where the documented
    // negative-h_eff sliver would trip the counted h floor.
    nodes.push({
      id: `f${i}`,
      type: "internal",
      x: i * SEG_L,
      y: 0,
      pressure: p0,
      quality: 1,
      volume: VOL,
    });
    solidNodes.push({
      id: `s${i}`,
      type: "solid",
      x: i * SEG_L,
      y: 1,
      temperature: opts.wallT0 ?? T_WALL0,
      mass: M_SEG,
      cp: CP_CU,
    });
  }
  nodes.push({
    id: `f${N + 1}`,
    type: "boundary",
    x: (N + 1) * SEG_L,
    y: 0,
    pressure: P_OUT,
    temperature: 300,
  });

  const model = opts.model ?? "ttWf";
  const conductors: NetworkConfig["conductors"] = [];
  for (let i = 1; i <= N; i++) {
    conductors.push({
      id: `conv${i}`,
      from: `f${i}`,
      to: `s${i}`,
      type: {
        kind: "convection",
        area: Math.PI * D * SEG_L,
        correlation:
          model === "ttWf"
            ? {
                model,
                diameter: D,
                axialPosition: i * SEG_L,
                segmentLength: SEG_L,
              }
            : { model, diameter: D, axialPosition: i * SEG_L },
      },
    } as Conductor);
  }
  const branches: NetworkConfig["branches"] = [];
  for (let i = 0; i <= N; i++) {
    branches.push({
      id: `pipe${i}`,
      from: `f${i}`,
      to: `f${i + 1}`,
      component: {
        type: "pipe",
        length: SEG_L,
        diameter: D,
        roughness: 1.5e-6,
      },
    });
  }

  return {
    meta: { name: `ttwf-net-${model}-${N}`, version: 2 },
    settings: opts.adaptive
      ? {
          mode: "transient",
          tolerance: 1e-6,
          maxIterations: 100,
          relaxation: 0.8,
          endTime: opts.endTime,
          timeStepping: "adaptive",
          adaptive: opts.adaptive,
        }
      : {
          mode: "transient",
          tolerance: 1e-6,
          maxIterations: 100,
          relaxation: 0.8,
          endTime: opts.endTime,
          dt: opts.dt ?? 0.25,
          timeStepping: "fixed",
        },
    fluid: { model: "realFluid", params: { fluidName: "ParaHydrogen" } },
    nodes,
    solidNodes,
    conductors,
    branches,
  };
}

/** First time a predicate holds on a recorded series, else undefined. */
function firstTime(
  times: number[],
  series: Array<number | boolean>,
  pred: (v: any) => boolean,
): number | undefined {
  for (let k = 0; k < times.length; k++) {
    if (pred(series[k])) return times[k];
  }
  return undefined;
}

/** Count false→true (`dir` = 'set') or true→false ('clear') transitions. */
function countTransitions(series: boolean[], dir: "set" | "clear"): number {
  let n = 0;
  for (let k = 0; k + 1 < series.length; k++) {
    if (dir === "set" && !series[k] && series[k + 1]) n++;
    if (dir === "clear" && series[k] && !series[k + 1]) n++;
  }
  return n;
}

/** Recorded-transition totals across all ttWf conductors of a result. */
function recordedLatchTransitions(res: TransientResult): {
  sets: number;
  clears: number;
} {
  let sets = 0;
  let clears = 0;
  for (const id of Object.keys(res.ttWf ?? {})) {
    sets += countTransitions(res.ttWf![id].rewetLatched, "set");
    clears += countTransitions(res.ttWf![id].rewetLatched, "clear");
  }
  return { sets, clears };
}

/* =============================================================================
 * 1–3, 6. Fixed-step 3-segment chilldown line (conservation, morphology,
 *        diagnostics, initialization)
 * ============================================================================= */
describe("TT-WF network: fixed-step 3-segment LH2 chilldown line", () => {
  let res: TransientResult;
  let diag: SolverDiagnostics;
  let cfg: NetworkConfig;
  const N = 3;

  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    fluid = new RealFluid("ParaHydrogen");
    resetSolverDiagnostics();
    cfg = buildLine({ nSeg: N, endTime: 12, dt: 0.25 });
    res = solveTransient(cfg);
    diag = getSolverDiagnostics();
  }, 180000);

  it("converges with clean diagnostics (C.6)", () => {
    expect(res.converged).toBe(true);
    // TT-WF counters: zero or explainable.
    expect(diag.ttWf.invalidInputCount).toBe(0);
    expect(diag.ttWf.notIntegratedCount).toBe(0); // legacy Phase-1 guard, must stay 0
    expect(diag.ttWf.latchClearCount).toBe(0); // no drying in a monotone chilldown
    // one latch set per conductor (measured: exactly 3)
    expect(diag.ttWf.latchSetCount).toBe(N);
    // fWetClamp: one clamp per front arrival at f = 1 (measured: 3)
    expect(diag.ttWf.fWetClampCount).toBeLessThanOrEqual(N);
    // no safeStatePH last-resort, no property failures, no missing walls
    expect(diag.statePHFallbackCount.lastResort).toBe(0);
    expect(diag.darrHartwig.propertyFailureCount).toBe(0);
    expect(diag.darrHartwig.missingWallTempCount).toBe(0);
    // no h-floor clamp: cold-vapor initial line keeps the signed h_eff off
    // the documented negative-h_eff sliver (measured: 0)
    expect(diag.hFloorClampCount).toBe(0);
  });

  it("initializes warm/dry walls UNWETTED at t = 0 (B.2)", () => {
    for (let i = 1; i <= N; i++) {
      const h = res.ttWf![`conv${i}`];
      // 300 K wall ≫ T_wet ≈ 32.5 K: unlatched, fWet = 0 — never arbitrarily wet
      expect(h.rewetLatched[0]).toBe(false);
      expect(h.fWet[0]).toBe(0);
    }
  });

  it("closes the GLOBAL fluid+solid energy balance (C.2, independent audit)", () => {
    const nT = res.times.length;
    // Stored energy from the recorded series ONLY (no solver internals):
    //   fluid:  U = Σ V·(ρh − P)          (u = h − P/ρ, m = ρV)
    //   solid:  H = Σ m·cp·T              (constant-cp wall)
    const eFluid = (k: number): number => {
      let e = 0;
      for (let i = 1; i <= N; i++) {
        const rho = res.nodes[`f${i}`].density[k];
        const h = res.nodes[`f${i}`].enthalpy![k];
        const P = res.nodes[`f${i}`].pressure[k];
        e += VOL * (rho * h - P);
      }
      return e;
    };
    const eSolid = (k: number): number => {
      let e = 0;
      for (let i = 1; i <= N; i++)
        e += M_SEG * CP_CU * res.solidNodes![`s${i}`].temperature[k];
      return e;
    };
    // Boundary enthalpy flux INTO the domain (upwind convention: an inflow
    // carries the upstream node's enthalpy — exactly the solver's energy
    // residual).  pipe0: f0(bnd)→f1; pipeN: fN→f{N+1}(bnd).
    const hB = (id: string, k: number) => res.nodes[id].enthalpy![k];
    const fluxInto = (k: number): number => {
      const m0 = res.branches["pipe0"].mdot[k];
      const mN = res.branches[`pipe${N}`].mdot[k];
      const in0 = m0 * (m0 >= 0 ? hB("f0", k) : hB("f1", k));
      const outN = mN * (mN >= 0 ? hB(`f${N}`, k) : hB(`f${N + 1}`, k));
      return in0 - outN;
    };
    // Implicit-Euler-consistent quadrature (right rectangle): the solver's
    // per-step balance is EXACTLY ΔE = Φ(t_{k+1})·dt (backward Euler with
    // end-of-step fluxes), so this is the matching quadrature — a trapezoid
    // audit would measure quadrature-convention mismatch, not solver error
    // (measured: 3.9e-2 trapezoid vs 1.4e-4 right-rectangle on this run).
    let integ = 0;
    for (let k = 0; k + 1 < nT; k++) {
      integ += fluxInto(k + 1) * (res.times[k + 1] - res.times[k]);
    }
    const dStored = eFluid(nT - 1) - eFluid(0) + (eSolid(nT - 1) - eSolid(0));
    const scale = Math.max(
      Math.abs(eSolid(nT - 1) - eSolid(0)),
      Math.abs(integ),
      1,
    );
    const rel = Math.abs(dStored - integ) / scale;
    // Measured 1.4e-4 (≈19 J on a 129 kJ scale — the accumulated ~1-W-class
    // per-step Newton residual floor).  1e-3 gives 7× margin.
    expect(rel).toBeLessThan(1e-3);
  });

  it("closes the LOCAL per-conductor wall energy balance (B.1)", () => {
    const nT = res.times.length;
    for (let i = 1; i <= N; i++) {
      // Recorded conductor heatRate = h·A·(T_fluid − T_wall) = heat INTO the
      // wall.  The wall has no conduction neighbours or heatInput in this
      // config, so m·cp·ΔT = ∫Q dt with the implicit (end-of-step) Q.
      let qInt = 0;
      for (let k = 0; k + 1 < nT; k++) {
        qInt +=
          res.conductors![`conv${i}`].heatRate[k + 1] *
          (res.times[k + 1] - res.times[k]);
      }
      const dW =
        M_SEG *
        CP_CU *
        (res.solidNodes![`s${i}`].temperature[nT - 1] -
          res.solidNodes![`s${i}`].temperature[0]);
      const rel = Math.abs(dW - qInt) / Math.max(Math.abs(dW), 1);
      // Measured ≤ 2.4e-3: the recorded Q is evaluated with a FRESH h-map at
      // the accepted state while the in-solve wall Newton used the last
      // under-relaxed outer-iteration map — a one-outer-iteration lag.
      expect(rel).toBeLessThan(1e-2);
    }
  });

  it("orders the rewet front inlet → outlet (C.3)", () => {
    const tSet: number[] = [];
    const tHalf: number[] = [];
    for (let i = 1; i <= N; i++) {
      const h = res.ttWf![`conv${i}`];
      // bounds at all times
      for (const f of h.fWet) {
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
      const ts = firstTime(res.times, h.rewetLatched, (v) => v === true);
      const th = firstTime(res.times, h.fWet, (v) => v >= 0.5);
      expect(ts, `conv${i} latch never set`).toBeDefined();
      expect(th, `conv${i} front never arrived`).toBeDefined();
      tSet.push(ts!);
      tHalf.push(th!);
      // fully wetted by the end of the run
      expect(h.fWet[h.fWet.length - 1]).toBeGreaterThanOrEqual(0.99);
      // monotone non-decreasing while latched (no dewet in chilldown)
      for (let k = 1; k < h.fWet.length; k++) {
        if (h.rewetLatched[k - 1]) {
          expect(h.fWet[k]).toBeGreaterThanOrEqual(h.fWet[k - 1]);
        }
      }
    }
    // No station pre-wets before its upstream neighbour.
    for (let i = 1; i < N; i++) {
      expect(tSet[i]).toBeGreaterThanOrEqual(tSet[i - 1]);
      expect(tHalf[i]).toBeGreaterThanOrEqual(tHalf[i - 1]);
    }
    // And the ordering is RESOLVED, not degenerate-simultaneous (measured
    // spread 1.25 s on latch set, 0.75 s on f ≥ 0.5 at dt = 0.25 s):
    expect(tSet[N - 1] - tSet[0]).toBeGreaterThanOrEqual(2 * 0.25);
    expect(tHalf[N - 1] - tHalf[0]).toBeGreaterThanOrEqual(2 * 0.25);
    // regime labels pass through the physical sequence FB → (TB) → NB(/DB)
    const regimes = res.ttWf!["conv1"].regime;
    expect(regimes[0]).toBe("FB"); // hot dry wall at t = 0
    expect(regimes).toContain("NB");
    // chilled end state: wet side, wall within a hair of local T_sat — DB or
    // the low-ΔT NB cusp depending on the final wall/node temperature split
    expect(["DB", "NB"]).toContain(regimes[regimes.length - 1]);
  });
});

/* =============================================================================
 * C.3 comparison — Darr–Hartwig on the same network (QUALITATIVE only)
 * ============================================================================= */
describe("TT-WF vs Darr–Hartwig: structural front-ordering comparison only", () => {
  let dh: TransientResult;
  const N = 3;

  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    dh = solveTransient(
      buildLine({ nSeg: N, model: "darrHartwig", endTime: 12, dt: 0.25 }),
    );
  }, 180000);

  it("D-H also cools the wall fronts inlet → outlet (no magnitude claims)", () => {
    expect(dh.converged).toBe(true);
    // D-H carries no recorded latch series; use the wall-temperature 40 K
    // crossing as the structural observable (measured: 7.50 / 8.25 / 8.75 s).
    const t40: number[] = [];
    for (let i = 1; i <= N; i++) {
      const t = firstTime(
        dh.times,
        dh.solidNodes![`s${i}`].temperature,
        (v) => v <= 40,
      );
      expect(t, `s${i} never crossed 40 K`).toBeDefined();
      t40.push(t!);
    }
    for (let i = 1; i < N; i++) {
      expect(t40[i]).toBeGreaterThanOrEqual(t40[i - 1]);
    }
    // Deliberately NO comparison of magnitudes or times against the TT-WF
    // run — this is a qualitative structural (ordering) check, not a fit.
  });
});

/* =============================================================================
 * C.1 — accepted-step immutability under adaptive step-doubling rejections
 * ============================================================================= */
describe("TT-WF network: adaptive run with rejected trials — replay-verified commit discipline", () => {
  let res: TransientResult;
  let diag: SolverDiagnostics;
  let cfg: NetworkConfig;
  const N = 3;

  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    fluid = new RealFluid("ParaHydrogen");
    resetSolverDiagnostics();
    cfg = buildLine({
      nSeg: N,
      endTime: 11,
      adaptive: { dtInitial: 0.25, dtMin: 0.05, dtMax: 1, relTol: 1e-3 },
    });
    res = solveTransient(cfg);
    diag = getSolverDiagnostics();
  }, 240000);

  it("produces at least one rejected trial (precondition of this test)", () => {
    expect(res.converged).toBe(true);
    expect(res.stats).toBeDefined();
    expect(res.stats!.rejectedSteps).toBeGreaterThanOrEqual(1);
    expect(diag.ttWf.invalidInputCount).toBe(0);
    expect(diag.statePHFallbackCount.lastResort).toBe(0);
  });

  it("histories align 1:1 with accepted times", () => {
    for (const id of Object.keys(res.ttWf ?? {})) {
      const h = res.ttWf![id];
      expect(h.fWet.length).toBe(res.times.length);
      expect(h.rewetLatched.length).toBe(res.times.length);
      expect(h.regime.length).toBe(res.times.length);
    }
  });

  it("every recorded fWet/latch is EXACTLY the one-step commit replay (no trial pollution)", () => {
    // Replay: for each conductor and each accepted step k → k+1, re-evaluate
    // the PURE closure with the recorded accepted state at k, the recorded
    // local inputs at k+1, and the accepted dt.  Equality must be EXACT —
    // the commit performs the same deterministic evaluation; a rejected
    // trial or Newton-iteration commit would desynchronize the state.
    const sats = new Map<string, DHSatState>();
    const satAt = (P: number): DHSatState => {
      // CoolProp calls are deterministic; cache by exact P bits.
      const key = String(P);
      let s = sats.get(key);
      if (!s) {
        const s0 = fluid.saturationProperties(P);
        s = {
          Tsat: s0.Tsat,
          hf: s0.hf,
          hfg: s0.hg - s0.hf,
          rhof: s0.rhof,
          rhog: s0.rhog,
          muf: s0.muf,
          mug: s0.mug,
          cpf: s0.cpf,
          cpg: s0.cpg,
          kf: s0.kf,
          kg: s0.kg,
          sigma: fluid.surfaceTension(P),
          Tcr: fluid.criticalTemperature(),
          TvapMax: 0.95 * getFluidLimits(fluid.fluidName).Tmax,
        };
        sats.set(key, s);
      }
      return s;
    };
    const wall = {
      massPerLength: M_SEG / SEG_L,
      enthalpy: (T: number) => CP_CU * T,
    };

    // axial coordinate per conductor id from the config
    const zOf = new Map<string, number>();
    const fluidNodeOf = new Map<string, string>();
    const wallNodeOf = new Map<string, string>();
    for (const c of cfg.conductors ?? []) {
      if (
        c.type.kind === "convection" &&
        c.type.correlation?.model === "ttWf"
      ) {
        zOf.set(c.id, c.type.correlation.axialPosition ?? 0);
        fluidNodeOf.set(c.id, c.from);
        wallNodeOf.set(c.id, c.to);
      }
    }
    const nT = res.times.length;
    let checked = 0;
    for (const id of Object.keys(res.ttWf ?? {})) {
      const hist = res.ttWf![id];
      const fid = fluidNodeOf.get(id)!;
      const wid = wallNodeOf.get(id)!;
      for (let k = 0; k + 1 < nT; k++) {
        // L from the START-of-step accepted latches (frozen step semantics)
        let zQf = -Infinity;
        for (const [oid, oh] of Object.entries(res.ttWf!)) {
          if (oh.rewetLatched[k] && (zOf.get(oid) ?? 0) > zQf)
            zQf = zOf.get(oid)!;
        }
        const z = zOf.get(id) ?? 0;
        const L = zQf > -Infinity ? z - zQf : z;

        const P = res.nodes[fid].pressure[k + 1];
        const sat = satAt(P);
        const hNode = clampToValidPH(
          fluid.fluidName,
          P,
          res.nodes[fid].enthalpy![k + 1],
        )[1];
        const Tnode = res.nodes[fid].temperature[k + 1];
        const Tw = res.solidNodes![wid].temperature[k + 1];
        // Documented G convention: ½·Σ|mdot| over attached branches / flow area
        const i = Number(fid.slice(1));
        const G =
          (0.5 *
            (Math.abs(res.branches[`pipe${i - 1}`].mdot[k + 1]) +
              Math.abs(res.branches[`pipe${i}`].mdot[k + 1]))) /
          A_FLUID;
        const dt = res.times[k + 1] - res.times[k];
        const T_LO = sat.Tsat + 0.25;
        const T_HI = Math.max(sat.TvapMax, T_LO);
        const vaporProps = (T: number): DHVaporProps =>
          fluid.transportPropsPT(P, Math.min(Math.max(T, T_LO), T_HI));
        const accepted: TtWfState = {
          fWet: hist.fWet[k],
          rewetLatched: hist.rewetLatched[k],
        };
        const out = evaluateTtWf({
          sat,
          vaporProps,
          Tw,
          Tnode,
          hNode,
          G,
          D,
          L,
          ReLin: (G * D) / sat.muf,
          segmentLength: SEG_L,
          dt,
          state: accepted,
          wall,
        });
        expect(
          out.ok,
          `replay failed for ${id} at step ${k + 1}: ${out.ok ? "" : out.reason}`,
        ).toBe(true);
        if (out.ok) {
          // The latch (a boolean) must be EXACT.  fWet must match to 1e-9:
          // the only replay/prod divergence is dt — the commit used the
          // accepted step size d, the replay recomputes it as
          // fl(t_k + d) − t_k (≤ 1 ulp difference).  A commit during a
          // rejected trial or Newton iteration would shift fWet by O(Δf) —
          // orders of magnitude above this tolerance.
          expect(
            Math.abs(out.result.proposedState.fWet - hist.fWet[k + 1]),
          ).toBeLessThanOrEqual(1e-9);
          expect(out.result.proposedState.rewetLatched).toBe(
            hist.rewetLatched[k + 1],
          );
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("latch-transition counters equal the recorded accepted-time transitions", () => {
    const { sets, clears } = recordedLatchTransitions(res);
    expect(diag.ttWf.latchSetCount).toBe(sets);
    expect(diag.ttWf.latchClearCount).toBe(clears);
    expect(sets).toBe(N); // each conductor rewets exactly once
    expect(clears).toBe(0);
  });
});

/* =============================================================================
 * C.4 — hysteresis at network scale (warm / cold / warm inlet cycle)
 * ============================================================================= */
describe("TT-WF network: warm–cold–warm hysteresis cycle (N=1)", () => {
  let res: TransientResult;
  let diag: SolverDiagnostics;

  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    resetSolverDiagnostics();
    // 300 K vapor → 23.5 K liquid (8–9 s, 1 s ramp) → 300 K vapor (20–21 s).
    // The reheat crosses T_wet + ΔT_h with χ_l = 0 (pure vapor) so the latch
    // must clear — exactly once.
    res = solveTransient(
      buildLine({
        nSeg: 1,
        endTime: 30,
        dt: 0.25,
        inletSchedule: [
          [0, 300],
          [8, 300],
          [9, 23.5],
          [20, 23.5],
          [21, 300],
          [30, 300],
        ],
      }),
    );
    diag = getSolverDiagnostics();
  }, 180000);

  it("exactly one latch set and one latch clear, counters equal history", () => {
    expect(res.converged).toBe(true);
    const h = res.ttWf!["conv1"];
    expect(countTransitions(h.rewetLatched, "set")).toBe(1);
    expect(countTransitions(h.rewetLatched, "clear")).toBe(1);
    // counter/history equality: no per-iteration chatter (a mid-Newton or
    // rejected-trial commit would inflate the counters beyond the history)
    expect(diag.ttWf.latchSetCount).toBe(1);
    expect(diag.ttWf.latchClearCount).toBe(1);
    expect(diag.ttWf.invalidInputCount).toBe(0);
    expect(diag.statePHFallbackCount.lastResort).toBe(0);
  });

  it("fWet monotone while latched, fully wets, dries to 0 on clear", () => {
    const h = res.ttWf!["conv1"];
    const kSet = h.rewetLatched.findIndex((v) => v);
    const kClear = h.rewetLatched.findIndex((v, k) => k > kSet && !v);
    expect(kSet).toBeGreaterThan(0);
    expect(kClear).toBeGreaterThan(kSet);
    // front fully traversed during the wet phase
    expect(Math.max(...h.fWet)).toBeGreaterThanOrEqual(0.99);
    // monotone non-decreasing between set and clear (no dewet inside ΔT_h)
    for (let k = kSet; k < kClear; k++) {
      expect(h.fWet[k]).toBeGreaterThanOrEqual(h.fWet[k - 1] ?? 0);
    }
    // held dry after the clear
    for (let k = kClear; k < h.fWet.length; k++) {
      expect(h.fWet[k]).toBe(0);
    }
    // regime morphology: dry (FB/SP) → wet (NB/DB) → dry again.  NOTE: the
    // label just BEFORE the clear is legitimately 'FB' — the wall is already
    // hotter than T_wet there, so the wet-side map itself is the film branch
    // (H1); the wet regimes appear mid-quench.
    expect(h.regime[0]).toMatch(/^(FB|SP)$/);
    const wetPhase = h.regime.slice(kSet, kClear);
    expect(wetPhase.some((r) => r === "NB" || r === "DB")).toBe(true);
    expect(h.regime[h.regime.length - 1]).toMatch(/^(FB|SP)$/);
  });
});

/* =============================================================================
 * C.5 — backward compatibility surface
 * ============================================================================= */
describe("TT-WF integration: backward compatibility", () => {
  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
  }, 60000);

  it("a non-ttWf network carries no TransientResult.ttWf field", () => {
    const r = solveTransient(
      buildLine({ nSeg: 1, model: "miropolskii", endTime: 1, dt: 0.25 }),
    );
    expect(r.converged).toBe(true);
    expect(r.ttWf).toBeUndefined();
  });

  it("a ttWf wall already cold at t = 0 initializes WETTED (memoryless init)", () => {
    // 25 K wall ≤ T_wet ≈ 32.5 K: initTtWfState ⇒ { fWet: 1, latched: true }.
    const r = solveTransient(
      buildLine({ nSeg: 1, endTime: 0.5, dt: 0.25, wallT0: 25 }),
    );
    expect(r.converged).toBe(true);
    expect(r.ttWf!["conv1"].fWet[0]).toBe(1);
    expect(r.ttWf!["conv1"].rewetLatched[0]).toBe(true);
  });
});
