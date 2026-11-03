/**
 * RectChannel — rectangular microchannel with the exact laminar duct law.
 *
 * References: Shah & London, "Laminar Flow Forced Convection in Ducts"
 * (1978), Table 41 (fully developed f·Re of rectangular ducts); Bruus,
 * "Theoretical Microfluidics" (2008) §3.4 / §4.2 (hydraulic resistance).
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import {
  RectChannel,
  rectHydraulicDiameter,
  rectLaminarResistance,
  rectPoiseuilleNumber,
  rectShapeFactor,
  RE_LAMINAR,
} from "../components";
import { solveSteady } from "../solver";
import { validateNetwork } from "../validate";
import { variable } from "../dual";
import { componentPressureDrop } from "../solver/pressureDrop";
import { parseText, serializeText } from "../../substrate/textProjection";

const P0 = 101325;
const MU = 1e-3; // water preset viscosity
const RHO = 998; // water preset density

type Comp = NetworkConfig["branches"][number]["component"];

function network(
  nodes: Array<{ id: string; p?: number; internal?: boolean }>,
  branches: Array<{ id: string; from: string; to: string; c: Comp }>,
): NetworkConfig {
  return {
    meta: { name: "rect", version: 2 },
    settings: { mode: "steady", tolerance: 1e-9, maxIterations: 200 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.internal ? "internal" : "boundary",
      x: 0,
      y: 0,
      pressure: n.p ?? P0,
      temperature: 300,
    })),
    branches: branches.map((b) => ({
      id: b.id,
      from: b.from,
      to: b.to,
      component: b.c,
    })),
  };
}

const rect = (w: number, h: number, L: number): Comp => ({
  type: "rectChannel",
  width: w,
  height: h,
  length: L,
});

describe("rectangular duct laminar law", () => {
  it("reproduces the Shah & London fully developed f·Re table", () => {
    // Darcy f·Re = 4 × the tabulated Fanning value.
    const table: Array<[number, number]> = [
      [1, 56.908],
      [0.5, 62.192],
      [0.25, 72.932],
      [0.125, 82.34],
    ];
    for (const [alpha, po] of table) {
      expect(rectPoiseuilleNumber(1, alpha)).toBeCloseTo(po, 1);
      expect(Math.abs(rectPoiseuilleNumber(1, alpha) - po) / po).toBeLessThan(
        2e-4,
      );
    }
    // Parallel-plate limit.
    expect(rectPoiseuilleNumber(1, 1e-4)).toBeCloseTo(96, 1);
  });

  it("is symmetric in width and height, with D_h = 2wh/(w+h)", () => {
    expect(rectPoiseuilleNumber(100e-6, 30e-6)).toBe(
      rectPoiseuilleNumber(30e-6, 100e-6),
    );
    expect(rectHydraulicDiameter(100e-6, 50e-6)).toBeCloseTo(
      (2 * 100e-6 * 50e-6) / 150e-6,
      18,
    );
    expect(rectShapeFactor(1, 1)).toBeCloseTo(0.42173, 5);
  });

  it("agrees with Bruus' resistance formula and its 1 − 0.63 h/w approximation", () => {
    const w = 100e-6,
      h = 20e-6,
      L = 0.01;
    const R = rectLaminarResistance(w, h, L, MU);
    const approx = (12 * MU * L) / (w * h ** 3 * (1 - 0.63 * (h / w)));
    // The approximation is quoted good to 0.2 % for h < w (Bruus eq. 4.47).
    expect(Math.abs(R - approx) / R).toBeLessThan(2e-3);
    // And the circle-equivalent hydraulic-diameter pipe is badly off, which is
    // why the dedicated component exists.
    const dh = rectHydraulicDiameter(w, h);
    const pipeR = (128 * MU * L) / (Math.PI * dh ** 4);
    expect(Math.abs(pipeR - R) / R).toBeGreaterThan(0.2);
  });
});

describe("RectChannel in a network", () => {
  it("solves a single channel to the exact laminar resistance and reports D_h-based Re", () => {
    const w = 100e-6,
      h = 50e-6,
      L = 0.01,
      dP = 1e4;
    const r = solveSteady(
      network(
        [{ id: "a", p: P0 + dP }, { id: "b" }],
        [{ id: "c", from: "a", to: "b", c: rect(w, h, L) }],
      ),
    );
    expect(r.converged).toBe(true);
    const Q = r.branches.c.mdot / RHO;
    const Qx = dP / rectLaminarResistance(w, h, L, MU);
    expect(Math.abs(Q - Qx) / Qx).toBeLessThan(1e-10);
    const V = Qx / (w * h);
    expect(r.branches.c.velocity).toBeCloseTo(V, 10);
    expect(r.branches.c.reynolds).toBeCloseTo(
      (RHO * V * rectHydraulicDiameter(w, h)) / MU,
      8,
    );
    // Converges quickly from the component's laminar warm start.
    expect(r.iterations).toBeLessThan(10);
  });

  it("stays linear down to nL/h flows (Re ~ 1e-9) and through zero and reverse flow", () => {
    const w = 20e-6,
      h = 10e-6,
      L = 0.02;
    const R = rectLaminarResistance(w, h, L, MU);
    for (const dP of [-500, -1e-3, 0, 1e-4, 1, 1e5]) {
      const r = solveSteady(
        network(
          [{ id: "a", p: P0 + dP }, { id: "b" }],
          [{ id: "c", from: "a", to: "b", c: rect(w, h, L) }],
        ),
      );
      expect(r.converged).toBe(true);
      const Q = r.branches.c.mdot / RHO;
      expect(Math.abs(Q - dP / R)).toBeLessThanOrEqual(
        1e-9 * Math.abs(dP / R) + 1e-24,
      );
    }
  });

  it("adds the hydrostatic head of a vertical channel", () => {
    const w = 200e-6,
      h = 200e-6,
      L = 0.05;
    const r = solveSteady(
      network(
        [{ id: "a", p: P0 + 2000 }, { id: "b" }],
        [
          {
            id: "c",
            from: "a",
            to: "b",
            c: { ...rect(w, h, L), elevationChange: 0.05 } as Comp,
          },
        ],
      ),
    );
    const Q = r.branches.c.mdot / RHO;
    const expected =
      (2000 - RHO * 9.80665 * 0.05) / rectLaminarResistance(w, h, L, MU);
    expect(Q).toBeCloseTo(expected, 15);
  });

  it("matches an independent linear nodal solve on a Wheatstone bridge of channels", () => {
    const geo: Array<[string, string, string, number, number, number]> = [
      ["e0", "in", "A", 100e-6, 50e-6, 0.01],
      ["e1", "in", "B", 60e-6, 50e-6, 0.012],
      ["e2", "A", "out", 80e-6, 40e-6, 0.008],
      ["e3", "B", "out", 100e-6, 25e-6, 0.015],
      ["e4", "A", "B", 50e-6, 50e-6, 0.004],
    ];
    const Pin = P0 + 5000;
    const cfg = network(
      [
        { id: "in", p: Pin },
        { id: "A", internal: true },
        { id: "B", internal: true },
        { id: "out" },
      ],
      geo.map(([id, from, to, w, h, L]) => ({
        id,
        from,
        to,
        c: rect(w, h, L),
      })),
    );
    const r = solveSteady(cfg);
    expect(r.converged).toBe(true);
    // Reference: 2×2 nodal conductance system.
    const g = geo.map(
      ([, , , w, h, L]) => 1 / rectLaminarResistance(w, h, L, MU),
    );
    const a11 = g[0] + g[2] + g[4],
      a12 = -g[4],
      a22 = g[1] + g[3] + g[4];
    const b1 = g[0] * Pin + g[2] * P0,
      b2 = g[1] * Pin + g[3] * P0;
    const det = a11 * a22 - a12 * a12;
    const PA = (b1 * a22 - a12 * b2) / det;
    const PB = (a11 * b2 - a12 * b1) / det;
    const P: Record<string, number> = { in: Pin, A: PA, B: PB, out: P0 };
    geo.forEach(([id, from, to], k) => {
      const Qref = (P[from] - P[to]) * g[k];
      const Q = r.branches[id].mdot / RHO;
      expect(Math.abs(Q - Qref) / Math.abs(Qref)).toBeLessThan(1e-9);
    });
  });

  it("accepts formula-bound geometry", () => {
    const cfg = network(
      [{ id: "a", p: P0 + 1000 }, { id: "b" }],
      [
        {
          id: "c",
          from: "a",
          to: "b",
          c: {
            type: "rectChannel",
            width: { expr: "2 * 50e-6" },
            height: 50e-6,
            length: 0.01,
          },
        },
      ],
    );
    expect(validateNetwork(cfg)).toEqual([]);
    const r = solveSteady(cfg);
    expect(r.branches.c.mdot / RHO).toBeCloseTo(
      1000 / rectLaminarResistance(100e-6, 50e-6, 0.01, MU),
      18,
    );
  });
});

describe("RectChannel transitional and turbulent regime", () => {
  const ch = new RectChannel(2e-3, 1e-3, 0.5, 1e-6);
  const A = 2e-3 * 1e-3;
  const dh = rectHydraulicDiameter(2e-3, 1e-3);
  const mdotAtRe = (Re: number) => (Re * MU * A) / dh;

  it("is continuous at the laminar edge", () => {
    const m = mdotAtRe(RE_LAMINAR);
    const below = ch.pressureDrop(m * (1 - 1e-9), RHO, MU);
    const above = ch.pressureDrop(m * (1 + 1e-9), RHO, MU);
    expect(Math.abs(above - below) / below).toBeLessThan(1e-6);
  });

  it("has a dual derivative that matches central differences in every regime", () => {
    for (const Re of [1e-6, 10, 2000, 2500, 3500, 1e4, 1e5, -50, -5e4]) {
      const m = mdotAtRe(Re);
      const d = ch.pressureDropDual(variable(m), RHO, MU);
      expect(d.v).toBeCloseTo(ch.pressureDrop(m, RHO, MU), 6);
      const hstep = Math.abs(m) * 1e-6;
      const fd =
        (ch.pressureDrop(m + hstep, RHO, MU) -
          ch.pressureDrop(m - hstep, RHO, MU)) /
        (2 * hstep);
      expect(Math.abs(d.d - fd) / Math.abs(fd)).toBeLessThan(1e-5);
    }
  });

  it("converges in the turbulent regime from its laminar warm start", () => {
    // 10 mm × 5 mm duct, 1 m, 20 kPa: Re ≈ 2e4.
    const r = solveSteady(
      network(
        [{ id: "a", p: P0 + 2e4 }, { id: "b" }],
        [{ id: "c", from: "a", to: "b", c: rect(10e-3, 5e-3, 1) }],
      ),
    );
    expect(r.converged).toBe(true);
    expect(r.branches.c.reynolds).toBeGreaterThan(1e4);
    const comp = new RectChannel(10e-3, 5e-3, 1);
    expect(
      Math.abs(comp.pressureDrop(r.branches.c.mdot, RHO, MU) - 2e4) / 2e4,
    ).toBeLessThan(1e-8);
  });

  it("bypasses the solver's zero-flow secant (exact below 1e-7 kg/s)", () => {
    const m = 1e-9;
    expect(componentPressureDrop(m, RHO, MU, ch)).toBe(
      ch.pressureDrop(m, RHO, MU),
    );
  });
});

describe("rectChannel validation and text format", () => {
  it("rejects non-positive geometry and negative roughness", () => {
    const errs = validateNetwork(
      network(
        [{ id: "a", p: P0 + 1 }, { id: "b" }],
        [
          {
            id: "c",
            from: "a",
            to: "b",
            c: {
              type: "rectChannel",
              width: 0,
              height: -1,
              length: 0.01,
              roughness: -1e-6,
            },
          },
        ],
      ),
    );
    expect(errs).toContain("Rect channel c width must be positive");
    expect(errs).toContain("Rect channel c height must be positive");
    expect(errs.some((e) => e.includes("roughness"))).toBe(true);
  });

  it("round-trips through the .fn text projection", () => {
    const cfg = network(
      [{ id: "a", p: P0 + 1 }, { id: "b" }],
      [
        {
          id: "c",
          from: "a",
          to: "b",
          c: { ...rect(100e-6, 50e-6, 0.01), roughness: 1e-7 } as Comp,
        },
      ],
    );
    const parsed = parseText(serializeText(cfg));
    expect(parsed.errors).toEqual([]);
    expect(parsed.config!.branches[0].component).toEqual(
      cfg.branches[0].component,
    );
  });
});
