import { describe, it, expect } from "vitest";
import {
  FLUID_BOUNDARY_SIZE,
  FLUID_INTERNAL_SIZE,
  SOLID_NODE_SIZE,
  GROUP_WIDTH,
  GROUP_HEIGHT,
  NODE_LABEL_GAP,
  GHOST_LABEL_GAP,
  FLUID_NODE_LABEL_OFFSET_Y,
  SOLID_NODE_LABEL_OFFSET_Y,
  EDGE_GLYPH_SIZE,
  EDGE_GLYPH_MIN_RUN,
  EDGE_GLYPH_FULL_RUN,
  EDGE_CHIP_OFFSET,
  EDGE_INTERACTION_WIDTH,
  CANVAS_GRID_SIZE,
  fluidNodeSize,
  fluidNodeCenter,
  solidNodeCenter,
  groupCenter,
  groupOriginForCenter,
  gridOriginForCenter,
  snapOriginToGrid,
  nodeLabelTop,
  ghostLabelTop,
  fluidNodeLabelOffsetY,
  edgeRun,
  edgeGlyphScale,
} from "../canvasGeometry";

describe("canvasGeometry constants (compact P&ID glyph set)", () => {
  it("locks the rendered sizes every consumer must agree on", () => {
    // These are the numbers CustomNode / CustomSolidNode / GroupContainer
    // render; changing them must be a deliberate visual change.
    expect(FLUID_BOUNDARY_SIZE).toBe(26);
    expect(FLUID_INTERNAL_SIZE).toBe(22);
    expect(SOLID_NODE_SIZE).toBe(26);
    expect(GROUP_WIDTH).toBe(140);
    expect(GROUP_HEIGHT).toBe(80);
  });

  it("locks the label anchors and edge glyph policy", () => {
    expect(NODE_LABEL_GAP).toBe(3);
    expect(GHOST_LABEL_GAP).toBe(2);
    expect(FLUID_NODE_LABEL_OFFSET_Y).toBe(30);
    expect(SOLID_NODE_LABEL_OFFSET_Y).toBe(30);
    expect(EDGE_GLYPH_SIZE).toBe(22);
    expect(EDGE_GLYPH_MIN_RUN).toBe(34);
    expect(EDGE_GLYPH_FULL_RUN).toBe(72);
    expect(EDGE_CHIP_OFFSET).toBe(32);
    expect(EDGE_INTERACTION_WIDTH).toBeGreaterThanOrEqual(20);
  });
});

describe("fluidNodeSize", () => {
  it("sizes boundary nodes larger than internal nodes", () => {
    expect(fluidNodeSize("boundary")).toBe(FLUID_BOUNDARY_SIZE);
    expect(fluidNodeSize("internal")).toBe(FLUID_INTERNAL_SIZE);
    expect(FLUID_BOUNDARY_SIZE).toBeGreaterThan(FLUID_INTERNAL_SIZE);
  });
});

describe("node centers", () => {
  it("centers a boundary node at half its size", () => {
    expect(fluidNodeCenter({ x: 100, y: 200, type: "boundary" })).toEqual({
      x: 100 + FLUID_BOUNDARY_SIZE / 2,
      y: 200 + FLUID_BOUNDARY_SIZE / 2,
    });
  });

  it("centers an internal node at half its size", () => {
    expect(fluidNodeCenter({ x: 100, y: 200, type: "internal" })).toEqual({
      x: 100 + FLUID_INTERNAL_SIZE / 2,
      y: 200 + FLUID_INTERNAL_SIZE / 2,
    });
  });

  it("centers a solid node at half the solid size", () => {
    expect(solidNodeCenter({ x: -30, y: 15 })).toEqual({
      x: -30 + SOLID_NODE_SIZE / 2,
      y: 15 + SOLID_NODE_SIZE / 2,
    });
  });
});

describe("group geometry", () => {
  it("centers a group container at half its width/height", () => {
    expect(groupCenter({ x: 10, y: 20 })).toEqual({
      x: 10 + GROUP_WIDTH / 2,
      y: 20 + GROUP_HEIGHT / 2,
    });
  });

  it("groupOriginForCenter inverts groupCenter", () => {
    const center = { x: 325, y: -117.5 };
    const origin = groupOriginForCenter(center.x, center.y);
    expect(origin).toEqual({
      x: center.x - GROUP_WIDTH / 2,
      y: center.y - GROUP_HEIGHT / 2,
    });
    expect(groupCenter(origin)).toEqual(center);
  });

  it("handles fractional centers without rounding", () => {
    // Subnetwork creation centers a container on a member bounding box whose
    // midpoint may be fractional — the math must not snap or round.
    const origin = groupOriginForCenter(0.5, 0.25);
    expect(origin).toEqual({
      x: 0.5 - GROUP_WIDTH / 2,
      y: 0.25 - GROUP_HEIGHT / 2,
    });
  });
});

describe("centered grid snapping", () => {
  it("snaps each differently-sized node by its visual center", () => {
    for (const size of [
      FLUID_BOUNDARY_SIZE,
      FLUID_INTERNAL_SIZE,
      SOLID_NODE_SIZE,
    ]) {
      const origin = snapOriginToGrid({ x: 101, y: 197 }, size, size);
      expect((origin.x + size / 2) % CANVAS_GRID_SIZE).toBe(0);
      expect((origin.y + size / 2) % CANVAS_GRID_SIZE).toBe(0);
    }
  });

  it("centers a dropped element on the nearest pointer grid point", () => {
    const origin = gridOriginForCenter(
      { x: 103, y: 202 },
      FLUID_BOUNDARY_SIZE,
      FLUID_BOUNDARY_SIZE,
    );
    expect(origin).toEqual({ x: 92, y: 182 });
    expect(fluidNodeCenter({ ...origin, type: "boundary" })).toEqual({
      x: 105,
      y: 195,
    });
  });

  it("centers group containers on the same grid", () => {
    const origin = snapOriginToGrid(
      { x: 101, y: 197 },
      GROUP_WIDTH,
      GROUP_HEIGHT,
    );
    const center = groupCenter(origin);
    expect(center.x % CANVAS_GRID_SIZE).toBe(0);
    expect(center.y % CANVAS_GRID_SIZE).toBe(0);
  });
});

describe("label anchors", () => {
  it("anchors a node label just below the glyph", () => {
    expect(nodeLabelTop(FLUID_BOUNDARY_SIZE)).toBe(
      FLUID_BOUNDARY_SIZE + NODE_LABEL_GAP,
    );
    expect(nodeLabelTop(FLUID_INTERNAL_SIZE)).toBe(
      FLUID_INTERNAL_SIZE + NODE_LABEL_GAP,
    );
    expect(nodeLabelTop(SOLID_NODE_SIZE)).toBe(
      SOLID_NODE_SIZE + NODE_LABEL_GAP,
    );
  });

  it("anchors a ghost label one px closer than a normal label", () => {
    expect(ghostLabelTop(FLUID_BOUNDARY_SIZE)).toBe(
      FLUID_BOUNDARY_SIZE + GHOST_LABEL_GAP,
    );
    expect(nodeLabelTop(48) - ghostLabelTop(48)).toBe(
      NODE_LABEL_GAP - GHOST_LABEL_GAP,
    );
  });

  it("per-type fluid label offsets track the rendered glyphs", () => {
    expect(fluidNodeLabelOffsetY("boundary")).toBe(
      nodeLabelTop(FLUID_BOUNDARY_SIZE) + 1,
    );
    expect(fluidNodeLabelOffsetY("internal")).toBe(
      nodeLabelTop(FLUID_INTERNAL_SIZE) + 1,
    );
  });

  it("declutter offsets sit at or below every rendered label anchor", () => {
    // The labelLayout estimates must not float above the real anchors or
    // chips would overlap the glyphs they name.
    expect(FLUID_NODE_LABEL_OFFSET_Y).toBeGreaterThanOrEqual(
      nodeLabelTop(FLUID_BOUNDARY_SIZE),
    );
    expect(FLUID_NODE_LABEL_OFFSET_Y).toBeGreaterThanOrEqual(
      nodeLabelTop(FLUID_INTERNAL_SIZE),
    );
    expect(SOLID_NODE_LABEL_OFFSET_Y).toBeGreaterThanOrEqual(
      nodeLabelTop(SOLID_NODE_SIZE),
    );
  });
});

describe("edgeRun", () => {
  it("measures a horizontal run: midpoint, angle 0, chip normal points down", () => {
    const run = edgeRun(10, 50, 110, 50);
    expect(run.length).toBe(100);
    expect(run.angleDeg).toBe(0);
    expect(run.midX).toBe(60);
    expect(run.midY).toBe(50);
    expect(run.normalX).toBeCloseTo(0);
    expect(run.normalY).toBeCloseTo(1);
  });

  it("measures a vertical run: angle +90 (y down), normal points left", () => {
    const run = edgeRun(50, 10, 50, 110);
    expect(run.length).toBe(100);
    expect(run.angleDeg).toBeCloseTo(90);
    expect(run.normalX).toBeCloseTo(-1);
    expect(run.normalY).toBeCloseTo(0);
  });

  it("measures a right-to-left run: angle 180", () => {
    const run = edgeRun(110, 50, 10, 50);
    expect(run.angleDeg).toBeCloseTo(180);
    expect(run.normalY).toBeCloseTo(-1);
  });

  it("degenerates safely for coincident endpoints", () => {
    const run = edgeRun(40, 40, 40, 40);
    expect(run.length).toBe(0);
    expect(run.angleDeg).toBe(0);
    expect(run.midX).toBe(40);
    // Normal falls back to straight down so the chip still clears the point.
    expect(run.normalX).toBe(0);
    expect(run.normalY).toBe(1);
  });
});

describe("edgeGlyphScale", () => {
  it("hides the glyph on runs too short to carry it", () => {
    expect(edgeGlyphScale(0)).toBe(0);
    expect(edgeGlyphScale(EDGE_GLYPH_MIN_RUN - 1)).toBe(0);
  });

  it("shrinks the glyph between the min run and the full-size run", () => {
    const s = edgeGlyphScale((EDGE_GLYPH_MIN_RUN + EDGE_GLYPH_FULL_RUN) / 2);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it("renders full size at and above the full-size run", () => {
    expect(edgeGlyphScale(EDGE_GLYPH_FULL_RUN)).toBe(1);
    expect(edgeGlyphScale(500)).toBe(1);
  });
});
