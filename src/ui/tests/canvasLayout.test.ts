import { describe, it, expect } from "vitest";
import { normalizeCanvasLayout } from "../canvasLayout";
import {
  buildChilldown,
  buildChilldownTwoPhase,
  threePipeJunction,
  pumpStartup,
} from "../examples";
import { cloneConfig } from "../utils";
import {
  CANVAS_GRID_SIZE,
  fluidNodeCenter,
  groupCenter,
  solidNodeCenter,
} from "../canvasGeometry";

function expectCentersOnGrid(cfg: ReturnType<typeof normalizeCanvasLayout>) {
  for (const node of cfg.nodes) {
    const center = fluidNodeCenter(node);
    expect(center.x % CANVAS_GRID_SIZE).toBeCloseTo(0);
    expect(center.y % CANVAS_GRID_SIZE).toBeCloseTo(0);
  }
  for (const node of cfg.solidNodes ?? []) {
    const center = solidNodeCenter(node);
    expect(center.x % CANVAS_GRID_SIZE).toBeCloseTo(0);
    expect(center.y % CANVAS_GRID_SIZE).toBeCloseTo(0);
  }
  for (const group of cfg.groups ?? []) {
    const center = groupCenter(group);
    expect(center.x % CANVAS_GRID_SIZE).toBeCloseTo(0);
    expect(center.y % CANVAS_GRID_SIZE).toBeCloseTo(0);
  }
}

describe("normalizeCanvasLayout", () => {
  it("lays the single-phase chilldown out at readable canvas pitch", () => {
    const cfg = buildChilldown();
    const out = normalizeCanvasLayout(cfg);
    const xs = out.nodes.map((n) => n.x);
    const span = Math.max(...xs) - Math.min(...xs);
    expect(span).toBeGreaterThanOrEqual(240);
    for (let i = 1; i < out.nodes.length; i++) {
      expect(out.nodes[i].x).toBeGreaterThan(out.nodes[i - 1].x);
    }
    expect(out.nodes[0].position?.x).toBe(0);
    expect(out.nodes[out.nodes.length - 1].position?.x).toBeCloseTo(60.96, 8);
    expectCentersOnGrid(out);
  });

  it("lays the two-phase chilldown out at readable canvas pitch", () => {
    const cfg = buildChilldownTwoPhase();
    const out = normalizeCanvasLayout(cfg);
    const xs = out.nodes.map((n) => n.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(240);
    expect(out.nodes[0].position?.x).toBe(0);
  });

  it("lands a resized note on the grid and leaves it there", () => {
    const cfg = cloneConfig(threePipeJunction);
    // An odd-multiple height: center-snapping such a card would leave a
    // half-grid residue and creep it downward on every later edit.
    cfg.notes = [
      { id: "NOTE1", text: "sized", x: 22, y: 128, width: 270, height: 225 },
    ];
    const out = normalizeCanvasLayout(cfg);
    expect(out.notes![0].y % CANVAS_GRID_SIZE).toBe(0);
    expect(out.notes![0].x % CANVAS_GRID_SIZE).toBe(0);
    // Idempotent: re-normalizing a settled layout must be a no-op.
    expect(normalizeCanvasLayout(out).notes).toEqual(out.notes);
    expect(out.notes![0]).toMatchObject({
      width: 270,
      height: 225,
      text: "sized",
    });
  });

  it("does NOT touch physics fields, ids, labels, or topology", () => {
    const cfg = buildChilldown({ segments: 4 });
    const out = normalizeCanvasLayout(cfg);
    expect(
      out.nodes.map((n) => [n.id, n.pressure, n.temperature, n.volume]),
    ).toEqual(
      cfg.nodes.map((n) => [n.id, n.pressure, n.temperature, n.volume]),
    );
    expect(out.branches).toEqual(cfg.branches);
    expect(out.conductors).toEqual(cfg.conductors);
    expect(
      out.solidNodes!.map((s) => [s.id, s.mass, s.cp, s.temperature]),
    ).toEqual(cfg.solidNodes!.map((s) => [s.id, s.mass, s.cp, s.temperature]));
    expect(out.settings).toEqual(cfg.settings);
    expect(out.fluid).toEqual(cfg.fluid);
  });

  it("center-snaps already-readable examples without rescaling them", () => {
    const junction = normalizeCanvasLayout(cloneConfig(threePipeJunction));
    const startup = normalizeCanvasLayout(cloneConfig(pumpStartup));
    expectCentersOnGrid(junction);
    expectCentersOnGrid(startup);
    expect(
      Math.max(...junction.nodes.map((n) => n.x)) -
        Math.min(...junction.nodes.map((n) => n.x)),
    ).toBeGreaterThanOrEqual(240);
  });

  it("is idempotent (normalized output passes through unchanged)", () => {
    const once = normalizeCanvasLayout(buildChilldownTwoPhase());
    expect(normalizeCanvasLayout(once)).toEqual(once);
  });

  it("handles degenerate configs (no nodes / single column)", () => {
    const empty = {
      meta: { name: "x", version: 2 },
      settings: { mode: "steady" },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [],
      branches: [],
    } as const;
    expect(normalizeCanvasLayout(empty as any)).toBe(empty);
    const oneCol = {
      ...empty,
      nodes: [
        {
          id: "a",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
        {
          id: "b",
          type: "boundary",
          x: 0,
          y: 100,
          pressure: 1e5,
          temperature: 300,
        },
      ],
    } as any;
    expectCentersOnGrid(normalizeCanvasLayout(oneCol));
  });
});
