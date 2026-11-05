/**
 * Wall discretization of the NBS 9264 chilldown line
 * (buildChilldownTwoPhase options inletWallCoupling / endWallLumping, used
 * by every validation solve through NBS_LINE_WALL_MODEL).  Structural,
 * no solve:
 *   - with NBS_LINE_WALL_MODEL no convection conductor touches a boundary
 *     fluid node (GFSSP's NBS model, AIAA 2015-3850 §4.3, has solid nodes
 *     on internal fluid nodes only);
 *   - the total wall mass and wetted area equal the line's;
 *   - the defaults still build the legacy configuration.
 */
import { describe, it, expect } from "vitest";
import { buildChilldownTwoPhase } from "../examples";
import {
  NBS_CHILLDOWN_RIG,
  NBS_LINE_WALL_MODEL,
} from "../../validation/nbsChilldown";

const L = NBS_CHILLDOWN_RIG.lengthM;
const D = 0.015875;
const OD = 0.01905;
const lineMass = 8960 * (Math.PI / 4) * (OD * OD - D * D) * L;
const lineArea = Math.PI * D * L;

function build(N: number, nbs: boolean) {
  return buildChilldownTwoPhase({
    segments: N,
    length: L,
    ...(nbs ? NBS_LINE_WALL_MODEL : {}),
  });
}

function convections(cfg: ReturnType<typeof build>) {
  return (cfg.conductors ?? []).filter((c) => c.type.kind === "convection");
}

describe("NBS line wall model", () => {
  for (const N of [3, 6, 12]) {
    it(`N = ${N}: every wall node convects to an internal fluid node`, () => {
      const cfg = build(N, true);
      const kind = new Map(cfg.nodes.map((n) => [n.id, n.type]));
      const conv = convections(cfg);
      expect(conv).toHaveLength(N + 1);
      for (const c of conv) expect(kind.get(c.from)).toBe("internal");
      expect(conv.find((c) => c.to === "s0")!.from).toBe("f1");
      expect(conv.find((c) => c.to === `s${N}`)!.from).toBe(`f${N - 1}`);
      for (let i = 1; i < N; i++)
        expect(conv.find((c) => c.to === `s${i}`)!.from).toBe(`f${i}`);
    });

    it(`N = ${N}: total wall mass and wetted area equal the line's`, () => {
      const cfg = build(N, true);
      const mass = cfg.solidNodes!.reduce((a, s) => a + (s.mass ?? 0), 0);
      const area = convections(cfg).reduce(
        (a, c) => a + (c.type as { area: number }).area,
        0,
      );
      expect(mass / lineMass).toBeCloseTo(1, 12);
      expect(area / lineArea).toBeCloseTo(1, 12);
      // End nodes own half a segment.
      const s = cfg.solidNodes!;
      expect(s[0].mass! / s[1].mass!).toBeCloseTo(0.5, 12);
      expect(s[N].mass! / s[1].mass!).toBeCloseTo(0.5, 12);
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
