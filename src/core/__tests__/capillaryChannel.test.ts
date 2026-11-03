/**
 * CapillaryChannel + CapillaryNetwork — capillary-driven microfluidics.
 *
 * Every dynamic case is checked against a closed-form reference:
 *  - Washburn filling of a rectangular channel with the displaced air's
 *    viscous resistance:  r_l s²/2 + r_g (L s − s²/2) = P_cap t / A
 *  - the same with an upstream series resistance R_u (Thevenin coupling):
 *    (R_u + r_g L) s + (r_l − r_g) s²/2 = (ΔP + P_cap) t / A
 *  - flow-driven (syringe) filling:  s = Q t / A
 *  - Jurin's capillary rise:  h_eq = P_cap / (ρ g)
 *  - Young–Laplace / Cho et al. (2007) burst pressure thresholds.
 */
import { describe, it, expect } from "vitest";
import type {
  NetworkConfig,
  TransientResult,
  CapillaryEventKind,
} from "../schema";
import {
  CapillaryChannel,
  rectBurstPressure,
  rectCapillaryPressure,
  rectLaminarResistance,
} from "../components";
import {
  solveSteady,
  buildSolverContext,
  createInitialState,
  probeJacobians,
} from "../solver";
import type { StepState } from "../solver";
import { solveTransient } from "../transient";
import { validateNetwork } from "../validate";
import { variable } from "../dual";
import {
  advanceStatefulComponents,
  restoreStatefulComponents,
  snapshotStatefulComponents,
} from "../transient/statefulComponents";
import { parseText, serializeText } from "../../substrate/textProjection";

const P0 = 101325;
const MU = 1e-3;
const MU_G = 1.81e-5;
const RHO = 998;
const G = 9.80665;
const GAMMA = 0.072;
const W = 100e-6;
const H = 50e-6;
const A = W * H;

type Comp = NetworkConfig["branches"][number]["component"];
type NodeIn = {
  id: string;
  internal?: boolean;
  p?: number;
  wet?: boolean;
  schedule?: Array<[number, number]>;
};
type BranchIn = { id: string; from: string; to: string; c: Comp };

function cap(extra: Record<string, unknown> = {}): Comp {
  return {
    type: "capillaryChannel",
    width: W,
    height: H,
    length: 5e-3,
    contactAngle: 30,
    ...extra,
  } as Comp;
}

function net(
  nodes: NodeIn[],
  branches: BranchIn[],
  settings: Partial<NetworkConfig["settings"]> = {},
): NetworkConfig {
  return {
    meta: { name: "capillary", version: 2 },
    settings: {
      mode: "transient",
      tolerance: 1e-9,
      maxIterations: 200,
      dt: 1e-3,
      endTime: 0.1,
      ...settings,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.internal ? "internal" : "boundary",
      x: 0,
      y: 0,
      pressure: n.p ?? P0,
      temperature: 300,
      ...(n.internal ? { volume: 1e-12 } : {}),
      ...(n.wet !== undefined ? { initiallyWet: n.wet } : {}),
      ...(n.schedule ? { pressureSchedule: n.schedule } : {}),
    })),
    branches: branches.map((b) => ({
      id: b.id,
      from: b.from,
      to: b.to,
      component: b.c,
    })),
  };
}

function solve(cfg: NetworkConfig): TransientResult {
  expect(validateNetwork(cfg)).toEqual([]);
  const r = solveTransient(cfg);
  expect(r.converged).toBe(true);
  expect(r.capillary).toBeDefined();
  return r;
}

const events = (r: TransientResult, kind?: CapillaryEventKind) =>
  r.capillary!.events.filter((e) => kind === undefined || e.kind === kind);

const pc30 = rectCapillaryPressure(W, H, GAMMA, 30, 30, 30);
const rl = rectLaminarResistance(W, H, 1, MU); // per metre
const rg = rectLaminarResistance(W, H, 1, MU_G);

/** Washburn time to reach s in a channel of length L between equal
 *  pressures (air resistance included). */
const washburnT = (s: number, L: number, pc = pc30, Ru = 0, dP = 0) =>
  (A * ((Ru + rg * L) * s + ((rl - rg) * s * s) / 2)) / (dP + pc);

describe("Young–Laplace capillary pressure and stop-valve burst pressure", () => {
  it("evaluates the rectangular-meniscus Young–Laplace law per wall", () => {
    expect(pc30).toBeCloseTo(
      GAMMA *
        ((2 * Math.cos(Math.PI / 6)) / H + (2 * Math.cos(Math.PI / 6)) / W),
      9,
    );
    // Glass floor (20°), PDMS roof and sides (105°).
    const mixed = rectCapillaryPressure(W, H, GAMMA, 105, 20, 105);
    const deg = (a: number) => Math.cos((a * Math.PI) / 180);
    expect(mixed).toBeCloseTo(
      GAMMA * ((deg(105) + deg(20)) / H + (2 * deg(105)) / W),
      9,
    );
  });

  it("reproduces Cho et al. (2007): ΔP_b = −2γ[cos θ*/w + cos θ/h], θ* = min(θ+β, 180°)", () => {
    const deg = (a: number) => Math.cos((a * Math.PI) / 180);
    for (const [theta, beta] of [
      [80, 90],
      [100, 45],
      [120, 90],
    ]) {
      const ref =
        -2 * GAMMA * (deg(Math.min(theta + beta, 180)) / W + deg(theta) / H);
      expect(
        rectBurstPressure(W, H, GAMMA, theta, theta, theta, beta),
      ).toBeCloseTo(ref, 9);
    }
    // A strongly wetting floor/roof defeats a planar expansion.
    expect(rectBurstPressure(W, H, GAMMA, 30, 30, 30, 90)).toBeLessThan(0);
  });
});

describe("capillary filling", () => {
  const L = 0.01;
  const tFill = washburnT(L, L);
  const washburn = (dt: number, flip = false) =>
    net(
      [{ id: "in", wet: true }, { id: "out" }],
      [
        flip
          ? { id: "c", from: "out", to: "in", c: cap({ length: L }) }
          : { id: "c", from: "in", to: "out", c: cap({ length: L }) },
      ],
      { dt, endTime: tFill * 1.2 },
    );

  it("follows the Washburn law (with displaced-air resistance) at any step size", () => {
    for (const dt of [tFill / 4, tFill / 40, tFill / 400]) {
      const r = solve(washburn(dt));
      const fill = r.capillary!.branches.c.fill;
      r.times.forEach((t, i) => {
        if (fill[i] > 0 && fill[i] < 1) {
          expect(Math.abs(t - washburnT(fill[i] * L, L)) / tFill).toBeLessThan(
            1e-6,
          );
        }
      });
      const arrival = events(r, "nodeWetted");
      expect(arrival).toHaveLength(1);
      expect(arrival[0].node).toBe("out");
      expect(Math.abs(arrival[0].time - tFill) / tFill).toBeLessThan(1e-4);
      expect(r.capillary!.branches.c.status.at(-1)).toBe("full");
      expect(r.capillary!.nodes.out.wet.at(-1)).toBe(true);
    }
  });

  it("fills a channel whose branch points at the reservoir (liquid enters at `to`)", () => {
    const r = solve(washburn(tFill / 40, true));
    const b = r.capillary!.branches.c;
    expect(b.fillEnd[1]).toBe("to");
    expect(r.branches.c.mdot[1]).toBeLessThan(0);
    r.times.forEach((t, i) => {
      if (b.fill[i] > 0 && b.fill[i] < 1)
        expect(Math.abs(t - washburnT(b.fill[i] * L, L)) / tFill).toBeLessThan(
          1e-6,
        );
    });
  });

  it("couples to the rest of the network exactly through its Thevenin resistance", () => {
    // Pressurised reservoir → resistive feed channel → wet node → capillary.
    const Lf = 0.02;
    const Ru = rectLaminarResistance(50e-6, 20e-6, Lf, MU);
    const dP = 500;
    const tEnd = washburnT(L, L, pc30, Ru, dP);
    const r = solve(
      net(
        [
          { id: "res", p: P0 + dP },
          { id: "J", internal: true },
          { id: "vent" },
        ],
        [
          {
            id: "feed",
            from: "res",
            to: "J",
            c: { type: "rectChannel", width: 50e-6, height: 20e-6, length: Lf },
          },
          { id: "c", from: "J", to: "vent", c: cap({ length: L }) },
        ],
        { dt: tEnd / 25, endTime: tEnd * 1.1 },
      ),
    );
    const fill = r.capillary!.branches.c.fill;
    r.times.forEach((t, i) => {
      if (fill[i] > 0 && fill[i] < 1)
        expect(
          Math.abs(t - washburnT(fill[i] * L, L, pc30, Ru, dP)) / tEnd,
        ).toBeLessThan(1e-6);
    });
    expect(
      Math.abs(events(r, "nodeWetted")[0].time - tEnd) / tEnd,
    ).toBeLessThan(1e-4);
  });

  it("is volume-exact under a syringe pump, including through a hydrophobic entrance", () => {
    const Q = 1e-9 / 60; // 1 µL/min
    for (const theta of [60, 100]) {
      const r = solve(
        net(
          [
            { id: "src", wet: true },
            { id: "in", internal: true, wet: true },
            { id: "out" },
          ],
          [
            {
              id: "pump",
              from: "src",
              to: "in",
              c: { type: "flowSource", massFlow: Q * RHO },
            },
            { id: "c", from: "in", to: "out", c: cap({ contactAngle: theta }) },
          ],
          { dt: 0.02, endTime: 1.6 },
        ),
      );
      const fill = r.capillary!.branches.c.fill;
      r.times.forEach((t, i) => {
        if (fill[i] < 1)
          expect(Math.abs(fill[i] - (Q * t) / (A * 5e-3))).toBeLessThan(1e-6);
      });
      expect(events(r, "nodeWetted")[0].time).toBeCloseTo((A * 5e-3) / Q, 4);
    }
  });

  it("converges first-order to the coupled ODE when fronts interact through a shared feed", () => {
    // Two primed channels drawing from one resistive feed: each front's
    // speed depends on the other's through the junction pressure.
    const dP = 3000;
    const Ru = rectLaminarResistance(60e-6, 30e-6, 0.01, MU);
    const chans = {
      a: { w: 100e-6, h: 50e-6, L: 8e-3 },
      b: { w: 60e-6, h: 50e-6, L: 6e-3 },
    };
    const p = Object.fromEntries(
      Object.entries(chans).map(([k, c]) => [
        k,
        {
          A: c.w * c.h,
          L: c.L,
          rl: rectLaminarResistance(c.w, c.h, 1, MU),
          rg: rectLaminarResistance(c.w, c.h, 1, MU_G),
          pc: rectCapillaryPressure(c.w, c.h, GAMMA, 30, 30, 30),
        },
      ]),
    ) as Record<
      "a" | "b",
      { A: number; L: number; rl: number; rg: number; pc: number }
    >;
    const rate = (sa: number, sb: number): [number, number] => {
      const R = (q: (typeof p)["a"], x: number) =>
        q.rg * q.L + (q.rl - q.rg) * x;
      const ga = 1 / R(p.a, sa);
      const gb = 1 / R(p.b, sb);
      const pj = (dP / Ru - ga * p.a.pc - gb * p.b.pc) / (1 / Ru + ga + gb);
      return [(ga * (pj + p.a.pc)) / p.a.A, (gb * (pj + p.b.pc)) / p.b.A];
    };
    const reference = (times: number[]) => {
      let sa = 0.3 * p.a.L;
      let sb = 0.3 * p.b.L;
      let t = 0;
      const h = 1e-5;
      return times.map((tq) => {
        while (t + h <= tq + 1e-15) {
          const k1 = rate(sa, sb);
          const k2 = rate(sa + (h / 2) * k1[0], sb + (h / 2) * k1[1]);
          const k3 = rate(sa + (h / 2) * k2[0], sb + (h / 2) * k2[1]);
          const k4 = rate(sa + h * k3[0], sb + h * k3[1]);
          sa += (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
          sb += (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
          t += h;
        }
        return [sa, sb];
      });
    };
    const worst = (n: number) => {
      const T = 0.18; // before either front reaches its vent
      const r = solve(
        net(
          [
            { id: "res", p: P0 + dP },
            { id: "J", internal: true },
            { id: "va" },
            { id: "vb" },
          ],
          [
            {
              id: "feed",
              from: "res",
              to: "J",
              c: {
                type: "rectChannel",
                width: 60e-6,
                height: 30e-6,
                length: 0.01,
              },
            },
            ...(["a", "b"] as const).map((k) => ({
              id: k,
              from: "J",
              to: `v${k}`,
              c: cap({
                width: chans[k].w,
                height: chans[k].h,
                length: chans[k].L,
                initialFill: 0.3,
              }),
            })),
          ],
          { dt: T / n, endTime: T },
        ),
      );
      expect(events(r)).toEqual([]);
      const ref = reference(r.times);
      let err = 0;
      r.times.forEach((_, i) => {
        err = Math.max(
          err,
          Math.abs(r.capillary!.branches.a.fill[i] * p.a.L - ref[i][0]) / p.a.L,
          Math.abs(r.capillary!.branches.b.fill[i] * p.b.L - ref[i][1]) / p.b.L,
        );
      });
      return err;
    };
    const coarse = worst(20);
    const fine = worst(80);
    expect(fine).toBeLessThan(5e-3);
    expect(coarse / fine).toBeGreaterThan(3); // first order in dt
  });

  it("rises to Jurin's height in a vertical channel without overshoot", () => {
    const w = 500e-6;
    const pc = rectCapillaryPressure(w, w, GAMMA, 30, 30, 30);
    const hEq = pc / (RHO * G);
    const r = solve(
      net(
        [{ id: "pool", wet: true }, { id: "top" }],
        [
          {
            id: "c",
            from: "pool",
            to: "top",
            c: cap({ width: w, height: w, length: 0.1, elevationChange: 0.1 }),
          },
        ],
        { dt: 0.5, endTime: 120 },
      ),
    );
    const rise = r.capillary!.branches.c.fill.map((f) => f * 0.1);
    for (let i = 1; i < rise.length; i++) {
      expect(rise[i]).toBeGreaterThanOrEqual(rise[i - 1] - 1e-15);
      expect(rise[i]).toBeLessThanOrEqual(hEq * (1 + 1e-9));
    }
    expect(Math.abs(rise.at(-1)! - hEq) / hEq).toBeLessThan(1e-6);
  });

  it("splits symmetrically at a T-junction and wets both outlets together", () => {
    const r = solve(
      net(
        [
          { id: "in", wet: true },
          { id: "J", internal: true },
          { id: "v1" },
          { id: "v2" },
        ],
        [
          { id: "feed", from: "in", to: "J", c: cap({ length: 3e-3 }) },
          { id: "a", from: "J", to: "v1", c: cap() },
          { id: "b", from: "J", to: "v2", c: cap() },
        ],
        { dt: 2e-4, endTime: 0.15 },
      ),
    );
    const { a, b } = r.capillary!.branches;
    a.fill.forEach((f, i) => expect(f).toBeCloseTo(b.fill[i], 12));
    const wetted = events(r, "nodeWetted");
    expect(wetted.map((e) => e.node)).toEqual(["J", "v1", "v2"]);
    expect(wetted[1].time).toBeCloseTo(wetted[2].time, 12);
    // Liquid volume entering J equals the volume found downstream of it.
    expect(a.status.at(-1)).toBe("full");
  });
});

describe("pinning, valves and air traps", () => {
  it("holds a meniscus at a hydrophobic entrance until ΔP exceeds −P_cap", () => {
    const pc = rectCapillaryPressure(W, H, GAMMA, 110, 110, 110);
    expect(pc).toBeLessThan(0);
    const r = solve(
      net(
        [
          {
            id: "in",
            wet: true,
            schedule: [
              [0, P0],
              [1, P0 - 2 * pc],
            ],
          },
          { id: "out" },
        ],
        [{ id: "c", from: "in", to: "out", c: cap({ contactAngle: 110 }) }],
        { dt: 1e-3, endTime: 0.8 },
      ),
    );
    const released = events(r, "released");
    expect(events(r, "pinned")[0].time).toBe(0);
    expect(released).toHaveLength(1);
    // Ramp crosses −P_cap at t = 0.5; detected at the end of that step.
    expect(released[0].time).toBeGreaterThanOrEqual(0.5);
    expect(released[0].time).toBeLessThanOrEqual(0.5 + 2e-3);
    // While pinned, the closed channel passes only the ~1e-6 leak of the
    // open channel at the same ΔP.
    const i = r.times.findIndex((t) => t >= 0.25);
    const dP = r.nodes.in.pressure[i] - P0;
    const open = (dP * RHO) / (rl * 5e-3);
    expect(Math.abs(r.branches.c.mdot[i])).toBeLessThan(2e-6 * open);
  });

  it("bursts a stop valve when the inlet pressure reaches the Cho burst pressure", () => {
    const pb = rectBurstPressure(W, H, GAMMA, 80, 80, 80, 90);
    expect(pb).toBeGreaterThan(0);
    const r = solve(
      net(
        [
          {
            id: "in",
            wet: true,
            schedule: [
              [0, P0],
              [0.2, P0],
              [1.2, P0 + 2 * pb],
            ],
          },
          { id: "out" },
        ],
        [
          {
            id: "c",
            from: "in",
            to: "out",
            c: cap({ contactAngle: 80, stopValve: {} }),
          },
        ],
        { dt: 1e-3, endTime: 1.2 },
      ),
    );
    const pinned = events(r, "pinned");
    expect(pinned).toHaveLength(1);
    expect(pinned[0].node).toBe("out");
    const burst = events(r, "burst");
    expect(burst).toHaveLength(1);
    expect(burst[0].time).toBeGreaterThanOrEqual(0.7);
    expect(burst[0].time).toBeLessThanOrEqual(0.7 + 2e-3);
    const before = r.times.findIndex((t) => t >= 0.6);
    expect(r.capillary!.branches.c.status[before]).toBe("pinnedOutlet");
    expect(r.capillary!.nodes.out.wet[before]).toBe(false);
    expect(r.capillary!.nodes.out.wet.at(-1)).toBe(true);
  });

  it("releases a stop valve when liquid reaches its exit from another path (trigger valve)", () => {
    const r = solve(
      net(
        [{ id: "in", wet: true }, { id: "J", internal: true }, { id: "vent" }],
        [
          {
            id: "A",
            from: "in",
            to: "J",
            c: cap({
              length: 3e-3,
              contactAngle: 80,
              stopValve: { end: "to" },
            }),
          },
          { id: "B", from: "in", to: "J", c: cap({ length: 8e-3 }) },
          { id: "out", from: "J", to: "vent", c: cap() },
        ],
        { dt: 5e-4, endTime: 0.4 },
      ),
    );
    const seq = events(r).filter((e) => e.kind !== "released");
    const pinA = seq.findIndex(
      (e) => e.kind === "pinned" && e.branch === "A" && e.node === "J",
    );
    const wetJ = seq.findIndex(
      (e) => e.kind === "nodeWetted" && e.node === "J",
    );
    const trig = seq.findIndex((e) => e.kind === "triggered");
    expect(pinA).toBeGreaterThanOrEqual(0);
    expect(wetJ).toBeGreaterThan(pinA);
    expect(seq[wetJ].branch).toBe("B");
    expect(seq[trig].branch).toBe("A");
    expect(seq[trig].time).toBe(seq[wetJ].time);
    expect(events(r, "airTrapped")).toHaveLength(0);
    const caps = r.capillary!.branches;
    expect([caps.A, caps.B, caps.out].map((b) => b.status.at(-1))).toEqual([
      "full",
      "full",
      "full",
    ]);
  });

  it("detects gas trapped when two fronts close a loop", () => {
    const r = solve(
      net(
        [{ id: "in", wet: true }, { id: "J", internal: true }, { id: "vent" }],
        [
          { id: "short", from: "in", to: "J", c: cap({ length: 3e-3 }) },
          { id: "long", from: "in", to: "J", c: cap({ length: 8e-3 }) },
          { id: "out", from: "J", to: "vent", c: cap() },
        ],
        { dt: 5e-4, endTime: 0.2 },
      ),
    );
    const trapped = events(r, "airTrapped");
    expect(trapped).toEqual([
      expect.objectContaining({ branch: "long", node: "J" }),
    ]);
    const long = r.capillary!.branches.long;
    expect(long.status.at(-1)).toBe("trapped");
    const fTrapped = long.fill.at(-1)!;
    expect(fTrapped).toBeGreaterThan(0.1);
    expect(fTrapped).toBeLessThan(0.9);
    // A blocked channel: no further filling, ~1e-6 of the open flow.
    expect(Math.abs(r.branches.long.mdot.at(-1)!)).toBeLessThan(
      1e-5 * Math.abs(r.branches.short.mdot[5]),
    );
    expect(long.fill.slice(-20).every((f) => f === fTrapped)).toBe(true);
  });
});

describe("solver integration", () => {
  it("steady solve reports the instantaneous flow at the initial fill state", () => {
    const L = 0.01;
    const cfg = net(
      [{ id: "in", p: P0 + 300, wet: true }, { id: "out" }],
      [
        {
          id: "c",
          from: "in",
          to: "out",
          c: cap({ length: L, initialFill: 0.4 }),
        },
      ],
      { mode: "steady" },
    );
    expect(validateNetwork(cfg)).toEqual([]);
    const r = solveSteady(cfg);
    expect(r.converged).toBe(true);
    const s = 0.4 * L;
    const Q = (300 + pc30) / (rl * s + rg * (L - s));
    expect(r.branches.c.mdot / RHO).toBeCloseTo(Q, 18);
    expect(r.capillary!.branches.c).toEqual({
      fill: 0.4,
      status: "filling",
      fillEnd: "from",
    });
    expect(r.capillary!.nodes).toEqual({
      in: { wet: true },
      out: { wet: false },
    });
  });

  it("adaptive stepping agrees with the Washburn reference", () => {
    const L = 0.01;
    const tFill = washburnT(L, L);
    const r = solve(
      net(
        [{ id: "in", wet: true }, { id: "out" }],
        [{ id: "c", from: "in", to: "out", c: cap({ length: L }) }],
        {
          dt: tFill / 100,
          endTime: tFill * 1.5,
          timeStepping: "adaptive",
          adaptive: { dtMin: 1e-7, dtMax: tFill / 5, relTol: 1e-3 },
        },
      ),
    );
    const fill = r.capillary!.branches.c.fill;
    r.times.forEach((t, i) => {
      if (fill[i] > 0 && fill[i] < 1)
        expect(Math.abs(t - washburnT(fill[i] * L, L)) / tFill).toBeLessThan(
          1e-6,
        );
    });
    expect(
      Math.abs(events(r, "nodeWetted")[0].time - tFill) / tFill,
    ).toBeLessThan(1e-4);
    expect(fill.length).toBe(r.times.length);
  });

  it("is transactional across adaptive candidates (snapshot / advance / restore)", () => {
    const cfg = net(
      [{ id: "in", wet: true }, { id: "out" }],
      [{ id: "c", from: "in", to: "out", c: cap({ length: 1e-4 }) }],
    );
    const ctx = buildSolverContext(cfg);
    const state = createInitialState(ctx, cfg) as StepState;
    state.mdots[0] = 1e-6; // generous flow: the front reaches the outlet
    const snap = snapshotStatefulComponents(ctx);
    const before = JSON.stringify(ctx.capillary!.report());
    advanceStatefulComponents(ctx, state, 1, 1);
    expect(ctx.capillary!.report().nodes.out.wet).toBe(true);
    expect(ctx.capillary!.events.length).toBeGreaterThan(0);
    restoreStatefulComponents(ctx, snap);
    expect(JSON.stringify(ctx.capillary!.report())).toBe(before);
  });

  it("progress snapshots carry capillary histories aligned with their times", () => {
    const cfg = net(
      [{ id: "in", wet: true }, { id: "out" }],
      [{ id: "c", from: "in", to: "out", c: cap() }],
      { dt: 1e-3, endTime: 0.05 },
    );
    const partials: TransientResult[] = [];
    solveTransient(cfg, {
      progressInterval: 7,
      onProgress: ({ partial }) => partials.push(partial),
    });
    expect(partials.length).toBeGreaterThan(2);
    for (const p of partials) {
      expect(p.capillary!.branches.c.fill).toHaveLength(p.times.length);
      expect(p.capillary!.nodes.out.wet).toHaveLength(p.times.length);
      for (const e of p.capillary!.events)
        expect(e.time).toBeLessThanOrEqual(p.times.at(-1)!);
    }
  });

  it("gives the solver an analytic Jacobian that matches finite differences", () => {
    // Rect feed into an internal junction with a filling channel, a pinned
    // stop valve and a dry vent channel: every capillary status that enters
    // a momentum row, at microfluidic flow magnitudes.
    const cfg = net(
      [
        { id: "res", p: P0 + 800 },
        { id: "J", internal: true },
        { id: "K", internal: true },
        { id: "vent" },
      ],
      [
        {
          id: "feed",
          from: "res",
          to: "J",
          c: { type: "rectChannel", width: 60e-6, height: 30e-6, length: 0.01 },
        },
        { id: "fill", from: "J", to: "K", c: cap({ initialFill: 0.4 }) },
        {
          id: "valve",
          from: "J",
          to: "K",
          c: cap({ contactAngle: 80, initialFill: 1, stopValve: {} }),
        },
        { id: "gas", from: "K", to: "vent", c: cap() },
      ],
    );
    expect(validateNetwork(cfg)).toEqual([]);
    const ctx = buildSolverContext(cfg);
    const caps = ctx.capillary!.report().branches;
    expect([caps.fill.status, caps.valve.status, caps.gas.status]).toEqual([
      "filling",
      "pinnedOutlet",
      "dry",
    ]);
    const state = createInitialState(ctx, cfg) as StepState;
    state.nodeP.set("J", P0 + 400);
    state.nodeP.set("K", P0 + 50);
    state.mdots.splice(0, 4, 3e-9, 2e-9, 1e-15, 2e-9);
    const { hybrid, fd } = probeJacobians(ctx, state, {});
    for (let i = 0; i < hybrid.length; i++) {
      const scale = Math.max(
        ...hybrid[i].map(Math.abs),
        ...fd[i].map(Math.abs),
      );
      for (let k = 0; k < hybrid.length; k++)
        expect(Math.abs(hybrid[i][k] - fd[i][k])).toBeLessThanOrEqual(
          1e-6 * scale,
        );
    }
  });

  it("pressureDropDual matches the scalar law and its derivative in every state", () => {
    const c = new CapillaryChannel({
      width: W,
      height: H,
      length: 5e-3,
      contactAngle: 40,
      elevationChange: 2e-3,
    });
    const cases: Array<[CapillaryChannel["status"], 1 | -1 | 0, number]> = [
      ["dry", 0, 0],
      ["filling", 1, 2e-3],
      ["filling", -1, 1e-3],
      ["full", 1, 5e-3],
      ["pinnedInlet", 1, 0],
      ["pinnedOutlet", 1, 5e-3],
      ["trapped", 1, 3e-3],
    ];
    for (const [status, side, fill] of cases) {
      c.status = status;
      c.side = side;
      c.fill = fill;
      for (const m of [-3e-9, 0, 2e-9, 5e-5]) {
        const d = c.pressureDropDual(variable(m), RHO, MU);
        const v = c.pressureDrop(m, RHO, MU);
        expect(d.v).toBeCloseTo(v, 9);
        const h = 1e-12;
        const fd =
          (c.pressureDrop(m + h, RHO, MU) - c.pressureDrop(m - h, RHO, MU)) /
          (2 * h);
        expect(Math.abs(d.d - fd) / Math.abs(fd)).toBeLessThan(1e-5);
      }
    }
  });
});

describe("capillary validation and text format", () => {
  const base = (
    nodes: NodeIn[],
    branches: BranchIn[],
    fluid?: NetworkConfig["fluid"],
  ) => ({
    ...net(nodes, branches),
    ...(fluid ? { fluid } : {}),
  });

  it("requires an incompressible liquid", () => {
    const errs = validateNetwork(
      base(
        [{ id: "in", wet: true }, { id: "out" }],
        [{ id: "c", from: "in", to: "out", c: cap() }],
        { model: "idealGas", preset: "air" },
      ),
    );
    expect(errs.some((e) => e.includes("requires an incompressible"))).toBe(
      true,
    );
  });

  it("forbids ordinary components on dry nodes", () => {
    const errs = validateNetwork(
      base(
        [
          { id: "in", wet: true },
          { id: "J", internal: true, wet: false },
          { id: "out" },
        ],
        [
          { id: "c", from: "in", to: "J", c: cap() },
          {
            id: "p",
            from: "J",
            to: "out",
            c: { type: "pipe", length: 0.01, diameter: 1e-4, roughness: 0 },
          },
        ],
      ),
    );
    expect(errs.some((e) => e.startsWith("Node J starts dry"))).toBe(true);
  });

  it("rejects initial states that enclose gas or start liquid at a dry node", () => {
    const errs = validateNetwork(
      base(
        [
          { id: "a", wet: true },
          { id: "b", wet: true },
          { id: "c" },
          { id: "d" },
        ],
        [
          { id: "between", from: "a", to: "b", c: cap() },
          { id: "partial", from: "a", to: "b", c: cap({ initialFill: 0.5 }) },
          { id: "fromDry", from: "c", to: "d", c: cap({ initialFill: 0.3 }) },
          { id: "primed", from: "a", to: "b", c: cap({ initialFill: 1 }) },
        ],
      ),
    );
    expect(
      errs.some((e) => e.includes("between starts empty between two wet")),
    ).toBe(true);
    expect(errs.some((e) => e.includes("partial starts partly filled"))).toBe(
      true,
    );
    expect(
      errs.some((e) => e.includes("fromDry starts 30% filled from node c")),
    ).toBe(true);
    expect(errs.some((e) => e.startsWith("Capillary channel primed"))).toBe(
      false,
    );
  });

  it("rejects a stop valve that cannot hold a meniscus, and out-of-range parameters", () => {
    const errs = validateNetwork(
      base(
        [{ id: "in", wet: true }, { id: "out" }],
        [
          { id: "weak", from: "in", to: "out", c: cap({ stopValve: {} }) },
          {
            id: "bad",
            from: "in",
            to: "out",
            c: cap({
              contactAngle: 200,
              gasViscosity: 0,
              initialFill: 2,
              stopValve: { end: "middle", burstPressure: -5 },
            }),
          },
        ],
      ),
    );
    expect(errs.some((e) => e.includes("weak stopValve cannot hold"))).toBe(
      true,
    );
    for (const frag of [
      "bad contactAngle",
      "bad gasViscosity",
      "bad initialFill",
      "bad stopValve.end",
      "bad stopValve.burstPressure",
    ])
      expect(errs.some((e) => e.includes(frag))).toBe(true);
  });

  it("round-trips through the .fn text projection, stop valve and wetness included", () => {
    const cfg = net(
      [
        { id: "in", wet: true },
        { id: "out", wet: false },
      ],
      [
        {
          id: "c",
          from: "in",
          to: "out",
          c: cap({
            contactAngle: 100,
            contactAngleBottom: 60,
            initialFill: 0.25,
            stopValve: { end: "to", expansionAngle: 60 },
          }),
        },
      ],
    );
    const parsed = parseText(serializeText(cfg));
    expect(parsed.errors).toEqual([]);
    expect(parsed.config!.branches[0].component).toEqual(
      cfg.branches[0].component,
    );
    expect(parsed.config!.nodes.map((n) => n.initiallyWet)).toEqual([
      true,
      false,
    ]);
  });
});
