/**
 * Wall discretization of the NBS 9264 chilldown line
 * (buildChilldownTwoPhase options endNodeLayout / endWallLumping, used by
 * every validation solve through NBS_LINE_WALL_MODEL).  Structural, no solve:
 *   - GFSSP's layout (AIAA 2015-3850 §4.3): N pipe segments between N + 1
 *     INTERNAL fluid nodes at x = 0 … L, a wall node on each, the boundary
 *     nodes on short end branches — so no convection conductor touches a
 *     boundary node and none is offset from its wall node;
 *   - the total wall mass, wetted area and fluid volume equal the line's;
 *   - the legacy layout (end walls borrowing a neighbour) and the defaults
 *     still build the legacy configuration.
 */
import { describe, it, expect } from "vitest";
import { buildChilldownTwoPhase } from "../examples";
import { physicalPosition } from "../../core";
import {
  NBS_CHILLDOWN_RIG,
  NBS_DOCUMENTED_OUTLET_PRESSURE_PA,
  NBS_INLET_RESTRICTION_K,
  NBS_INLET_RESTRICTION_K_SENSITIVITY,
  NBS_LINE_FLOW_MODEL,
  NBS_LINE_WALL_MODEL,
  NBS_LINE_WALL_MODEL_LEGACY,
  NBS_OUTLET_PRESSURE_PA,
} from "../../validation/nbsChilldown";

const L = NBS_CHILLDOWN_RIG.lengthM;
const D = 0.015875;
const OD = 0.01905;
const lineMass = 8960 * (Math.PI / 4) * (OD * OD - D * D) * L;
const lineArea = Math.PI * D * L;

function build(N: number, nbs: boolean | "legacy") {
  return buildChilldownTwoPhase({
    segments: N,
    length: L,
    ...(nbs === true
      ? NBS_LINE_WALL_MODEL
      : nbs === "legacy"
        ? NBS_LINE_WALL_MODEL_LEGACY
        : {}),
  });
}

function convections(cfg: ReturnType<typeof build>) {
  return (cfg.conductors ?? []).filter((c) => c.type.kind === "convection");
}

const px = (n: Parameters<typeof physicalPosition>[0]) =>
  physicalPosition(n)?.x ?? NaN;

describe("NBS line wall model (GFSSP layout)", () => {
  for (const N of [3, 6, 12, 30]) {
    it(`N = ${N}: N + 1 internal fluid nodes, each wall node on the fluid node at its own position`, () => {
      const cfg = build(N, true);
      const kind = new Map(cfg.nodes.map((n) => [n.id, n]));
      const conv = convections(cfg);
      expect(conv).toHaveLength(N + 1);
      expect(cfg.nodes.filter((n) => n.type === "internal")).toHaveLength(
        N + 1,
      );
      expect(cfg.nodes.filter((n) => n.type === "boundary")).toHaveLength(2);
      expect(cfg.branches).toHaveLength(N + 2);
      const wall = new Map(cfg.solidNodes!.map((s) => [s.id, s]));
      for (const c of conv) {
        const f = kind.get(c.from)!;
        expect(f.type).toBe("internal");
        expect(px(f)).toBeCloseTo(px(wall.get(c.to)!), 9);
      }
      expect(px(wall.get("s0")!)).toBeCloseTo(0, 12);
      expect(px(wall.get(`s${N}`)!)).toBeCloseTo(L, 9);
    });

    it(`N = ${N}: total wall mass, wetted area and fluid volume equal the line's`, () => {
      const cfg = build(N, true);
      const mass = cfg.solidNodes!.reduce((a, s) => a + (s.mass ?? 0), 0);
      const area = convections(cfg).reduce(
        (a, c) => a + (c.type as { area: number }).area,
        0,
      );
      const vol = cfg.nodes.reduce(
        (a, n) => a + (n.type === "internal" ? Number(n.volume) : 0),
        0,
      );
      expect(mass / lineMass).toBeCloseTo(1, 12);
      expect(area / lineArea).toBeCloseTo(1, 12);
      expect(vol / ((Math.PI / 4) * D * D * L)).toBeCloseTo(1, 12);
      const s = cfg.solidNodes!;
      expect(s[0].mass! / s[1 % s.length].mass!).toBeCloseTo(
        N > 1 ? 0.5 : 1,
        12,
      );
    });
  }

  it("the end branches are short and the pipe segments are L/N", () => {
    const N = 6;
    const cfg = build(N, true);
    const len = (id: string) =>
      (cfg.branches.find((b) => b.id === id)!.component as { length: number })
        .length;
    expect(len("pipe0")).toBeLessThan(0.01 * L);
    expect(len(`pipe${N + 1}`)).toBeLessThan(0.01 * L);
    for (let j = 1; j <= N; j++) expect(len(`pipe${j}`)).toBeCloseTo(L / N, 12);
  });
});

describe("legacy line wall model (end walls borrow a neighbour)", () => {
  for (const N of [3, 6, 12]) {
    it(`N = ${N}: every wall node convects to an internal fluid node`, () => {
      const cfg = build(N, "legacy");
      const kind = new Map(cfg.nodes.map((n) => [n.id, n.type]));
      const conv = convections(cfg);
      expect(conv).toHaveLength(N + 1);
      for (const c of conv) expect(kind.get(c.from)).toBe("internal");
      expect(conv.find((c) => c.to === "s0")!.from).toBe("f1");
      expect(conv.find((c) => c.to === `s${N}`)!.from).toBe(`f${N - 1}`);
    });
  }

  it("defaults keep the legacy layout (inlet wall on the boundary, full end nodes)", () => {
    const N = 3;
    const cfg = build(N, false);
    const conv = convections(cfg);
    expect(conv.find((c) => c.to === "s0")!.from).toBe("f0");
    expect(conv.find((c) => c.to === `s${N}`)!.from).toBe(`f${N}`);
    const mass = cfg.solidNodes!.reduce((a, s) => a + (s.mass ?? 0), 0);
    expect(mass / lineMass).toBeCloseTo((N + 1) / N, 12);
  });

  it("rejects downwind inlet coupling without an internal node", () => {
    expect(() =>
      buildChilldownTwoPhase({ segments: 1, inletWallCoupling: "downwind" }),
    ).toThrow(/at least 2 segments/);
  });
});

/**
 * Flow model of the NBS validation solves (NBS_LINE_FLOW_MODEL): longitudinal
 * inertia and the inlet restriction.  Structural; the solves are gated in
 * chilldownFlowModel.test.ts and chilldownBaseline.test.ts.
 */
describe("NBS line flow model (inertia, inlet restriction)", () => {
  const A = (Math.PI / 4) * D * D;
  const nbs = (N: number) =>
    buildChilldownTwoPhase({
      segments: N,
      length: L,
      ...NBS_LINE_WALL_MODEL,
      ...NBS_LINE_FLOW_MODEL,
    });

  it("is GFSSP's formulation: inertia on, a K-factor inlet restriction of K = 2", () => {
    expect(NBS_LINE_FLOW_MODEL.longitudinalInertia).toBe(true);
    expect(NBS_LINE_FLOW_MODEL.inletRestrictionK).toBe(NBS_INLET_RESTRICTION_K);
    expect(NBS_INLET_RESTRICTION_K).toBe(2);
    // The sensitivity brackets the nominal value.
    expect(NBS_INLET_RESTRICTION_K_SENSITIVITY[0]).toBeLessThan(
      NBS_INLET_RESTRICTION_K,
    );
    expect(NBS_INLET_RESTRICTION_K_SENSITIVITY[1]).toBeGreaterThan(
      NBS_INLET_RESTRICTION_K,
    );
  });

  it("longitudinalInertia turns on the momentum-flux and kinetic-energy terms", () => {
    const cfg = nbs(3);
    expect(cfg.settings.momentumFlux).toBe(true);
    expect(cfg.settings.kineticEnergy).toBe(true);
  });

  it("the inlet branch becomes a resistance (not an orifice) on the line's flow area", () => {
    for (const N of [3, 30]) {
      const cfg = nbs(N);
      const b = cfg.branches.find((x) => x.id === "pipe0")!;
      expect(b.from).toBe("f0");
      expect(b.to).toBe("f1");
      expect(b.component).toEqual({
        type: "resistance",
        k: NBS_INLET_RESTRICTION_K,
        area: A,
      });
      // The outlet branch and the line segments are unchanged pipes.
      expect(
        cfg.branches.find((x) => x.id === `pipe${N + 1}`)!.component.type,
      ).toBe("pipe");
      for (let j = 1; j <= N; j++)
        expect(
          cfg.branches.find((x) => x.id === `pipe${j}`)!.component.type,
        ).toBe("pipe");
    }
  });

  it("defaults are unchanged: no inertia terms and the 0.05 m inlet pipe", () => {
    for (const cfg of [
      buildChilldownTwoPhase(),
      buildChilldownTwoPhase({
        segments: 3,
        length: L,
        ...NBS_LINE_WALL_MODEL,
      }),
    ]) {
      expect(cfg.settings.momentumFlux).toBeUndefined();
      expect(cfg.settings.kineticEnergy).toBeUndefined();
      expect(cfg.branches[0].component.type).toBe("pipe");
    }
  });

  it("rejects an inlet restriction without the internal layout, and a negative K", () => {
    expect(() =>
      buildChilldownTwoPhase({ segments: 3, inletRestrictionK: 2 }),
    ).toThrow(/endNodeLayout/);
    expect(() =>
      buildChilldownTwoPhase({
        segments: 3,
        endNodeLayout: "internal",
        inletRestrictionK: -1,
      }),
    ).toThrow(/K ≥ 0/);
  });

  it("the outlet stays at one atmosphere; the documented 12.05 psia is a sensitivity input", () => {
    expect(NBS_OUTLET_PRESSURE_PA).toBe(101325);
    expect(NBS_DOCUMENTED_OUTLET_PRESSURE_PA / 6894.757).toBeCloseTo(12.05, 3);
  });
});
