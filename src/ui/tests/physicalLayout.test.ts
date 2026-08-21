import { describe, it, expect } from "vitest";
import {
  physicalLayout,
  projectLayout,
  deriveMetresPerPixel,
  DEFAULT_METRES_PER_PIXEL,
  type FluidElement,
  type PositionedElement,
} from "../physicalLayout";
import { VIEW_PRESETS } from "../projection3d";
import { fluidNodeCenter, solidNodeCenter } from "../canvasGeometry";

const internal = (
  id: string,
  x: number,
  y: number,
  position?: FluidElement["position"],
): FluidElement => ({ id, x, y, type: "internal", position });

const close = (a: number, b: number, tol = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThan(tol);

describe("physicalLayout per-axis fallback", () => {
  it("prefers authored metres and infers only the missing axes", () => {
    const layout = physicalLayout({
      nodes: [internal("a", 0, 0, { x: 42, z: 7 })],
      solidNodes: [],
    });
    const p = layout.placements.get("a")!;
    expect(p.x).toBe(42);
    expect(p.z).toBe(7);
    expect(p.y).toBe(0);
    expect(p.inferred).toEqual({ x: false, y: true, z: false });
  });

  it("infers every axis when no physical position is authored", () => {
    const layout = physicalLayout({
      nodes: [internal("a", 60, 30)],
      solidNodes: [],
    });
    const p = layout.placements.get("a")!;
    const centre = fluidNodeCenter({ x: 60, y: 30, type: "internal" });
    close(p.x, centre.x * DEFAULT_METRES_PER_PIXEL);
    close(p.z, -centre.y * DEFAULT_METRES_PER_PIXEL);
    expect(p.y).toBe(0);
    expect(p.inferred).toEqual({ x: true, y: true, z: true });
  });

  it("treats formula-bound axes as unset and falls back", () => {
    const layout = physicalLayout({
      nodes: [internal("a", 80, 40, { x: { expr: "tankHeight" }, y: 3 })],
      solidNodes: [],
    });
    const p = layout.placements.get("a")!;
    const centre = fluidNodeCenter({ x: 80, y: 40, type: "internal" });
    close(p.x, centre.x * DEFAULT_METRES_PER_PIXEL);
    expect(p.y).toBe(3);
    expect(p.inferred.x).toBe(true);
    expect(p.inferred.y).toBe(false);
  });

  it("ignores non-finite authored values", () => {
    const layout = physicalLayout({
      nodes: [
        internal("a", 0, 0, { x: Number.NaN, z: Number.POSITIVE_INFINITY }),
      ],
      solidNodes: [],
    });
    const p = layout.placements.get("a")!;
    expect(p.inferred).toEqual({ x: true, y: true, z: true });
  });

  it("places solid nodes from their own rendered centre", () => {
    const solid: PositionedElement = { id: "s", x: 100, y: 50 };
    const layout = physicalLayout({ nodes: [], solidNodes: [solid] });
    const centre = solidNodeCenter(solid);
    const p = layout.placements.get("s")!;
    close(p.x, centre.x * DEFAULT_METRES_PER_PIXEL);
    close(p.z, -centre.y * DEFAULT_METRES_PER_PIXEL);
    expect(layout.halfSizes.get("s")).toBe(13);
  });
});

describe("deriveMetresPerPixel", () => {
  it("reads the scale off the model when physical x spans are authored", () => {
    expect(
      deriveMetresPerPixel([
        { id: "a", x: 0, y: 0, position: { x: 0 } },
        { id: "b", x: 200, y: 0, position: { x: 10 } },
      ]),
    ).toBeCloseTo(10 / 200, 12);
  });

  it("falls back to the constant without enough physical extent", () => {
    expect(
      deriveMetresPerPixel([{ id: "a", x: 0, y: 0, position: { x: 5 } }]),
    ).toBe(DEFAULT_METRES_PER_PIXEL);
    expect(deriveMetresPerPixel([{ id: "a", x: 0, y: 0 }])).toBe(
      DEFAULT_METRES_PER_PIXEL,
    );
    expect(deriveMetresPerPixel([])).toBe(DEFAULT_METRES_PER_PIXEL);
  });

  it("ignores a zero canvas span that would divide by zero", () => {
    expect(
      deriveMetresPerPixel([
        { id: "a", x: 50, y: 0, position: { x: 0 } },
        { id: "b", x: 50, y: 90, position: { x: 10 } },
      ]),
    ).toBe(DEFAULT_METRES_PER_PIXEL);
  });
});

describe("projectLayout", () => {
  const schematic: FluidElement[] = [
    internal("a", 0, 0),
    internal("b", 170, 0),
    internal("c", 170, 120),
  ];

  it("reproduces the schematic layout exactly at the front camera", () => {
    const layout = physicalLayout({ nodes: schematic, solidNodes: [] });
    const screen = projectLayout(layout, VIEW_PRESETS.front);
    for (const node of schematic) {
      const centre = fluidNodeCenter(node);
      const placed = screen.get(node.id)!;
      close(placed.x, centre.x, 1e-6);
      close(placed.y, centre.y, 1e-6);
    }
  });

  it("gives an all-inferred model one uniform depth at the front camera", () => {
    const layout = physicalLayout({ nodes: schematic, solidNodes: [] });
    const ts = [...projectLayout(layout, VIEW_PRESETS.front).values()].map(
      (p) => p.t,
    );
    expect(ts.every((t) => t === 0)).toBe(true);
  });

  it("still separates an all-inferred model in depth once orbited", () => {
    // The inferred plane is flat in physical y, but it is a plane in space:
    // yawing it must spread depth, which is what makes the orbit read as 3D.
    const layout = physicalLayout({ nodes: schematic, solidNodes: [] });
    const ts = [...projectLayout(layout, VIEW_PRESETS.iso).values()].map(
      (p) => p.t,
    );
    expect(Math.max(...ts)).toBe(1);
    expect(Math.min(...ts)).toBe(0);
  });

  it("separates depth once a physical y is authored", () => {
    const layout = physicalLayout({
      nodes: [
        internal("near", 0, 0, { y: -5 }),
        internal("far", 170, 0, { y: 5 }),
      ],
      solidNodes: [],
    });
    const screen = projectLayout(layout, VIEW_PRESETS.iso);
    const near = screen.get("near")!;
    const far = screen.get("far")!;
    expect(near.depth).toBeLessThan(far.depth);
    expect(near.t).toBe(0);
    expect(far.t).toBe(1);
  });

  it("normalizes depth into the unit range for every element", () => {
    const layout = physicalLayout({
      nodes: [
        internal("a", 0, 0, { y: -5 }),
        internal("b", 60, 0, { y: 0 }),
        internal("c", 120, 0, { y: 12 }),
      ],
      solidNodes: [],
    });
    for (const placed of projectLayout(layout, VIEW_PRESETS.iso).values()) {
      expect(placed.t).toBeGreaterThanOrEqual(0);
      expect(placed.t).toBeLessThanOrEqual(1);
    }
  });

  it("orbits about the model centroid, so the centroid stays anchored", () => {
    const layout = physicalLayout({ nodes: schematic, solidNodes: [] });
    const centroidOf = (camera: Parameters<typeof projectLayout>[1]) => {
      const points = [...projectLayout(layout, camera).values()];
      return {
        x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
        y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
      };
    };
    const front = centroidOf(VIEW_PRESETS.front);
    const iso = centroidOf(VIEW_PRESETS.iso);
    close(front.x, iso.x, 1e-6);
    close(front.y, iso.y, 1e-6);
  });

  it("handles an empty canvas without producing NaN", () => {
    const layout = physicalLayout({ nodes: [], solidNodes: [] });
    expect(layout.placements.size).toBe(0);
    expect(Number.isFinite(layout.pivot.x)).toBe(true);
    expect(projectLayout(layout, VIEW_PRESETS.iso).size).toBe(0);
  });
});
