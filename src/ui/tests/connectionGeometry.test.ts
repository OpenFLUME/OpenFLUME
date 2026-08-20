import { describe, it, expect } from "vitest";
import { Position } from "@xyflow/react";
import {
  connectionOrientation,
  DEFAULT_ORIENTATION,
  VERTICAL_DOMINANCE,
  SIDE_POSITION,
  sourceHandleId,
  targetHandleId,
} from "../connectionGeometry";

describe("connectionOrientation", () => {
  it("connects Right → Left when the target is to the right", () => {
    const o = connectionOrientation({ x: 0, y: 0 }, { x: 200, y: 10 });
    expect(o.sourceSide).toBe("right");
    expect(o.targetSide).toBe("left");
    expect(o.sourcePosition).toBe(Position.Right);
    expect(o.targetPosition).toBe(Position.Left);
    expect(o.sourceHandle).toBe("s-right");
    expect(o.targetHandle).toBe("t-left");
  });

  it("connects Left → Right when the target is to the left", () => {
    const o = connectionOrientation({ x: 0, y: 0 }, { x: -200, y: 10 });
    expect(o.sourceSide).toBe("left");
    expect(o.targetSide).toBe("right");
    expect(o.sourcePosition).toBe(Position.Left);
    expect(o.targetPosition).toBe(Position.Right);
  });

  it("connects Bottom → Top when the target is below (screen +y is down)", () => {
    const o = connectionOrientation({ x: 0, y: 0 }, { x: 0, y: 200 });
    expect(o.sourceSide).toBe("bottom");
    expect(o.targetSide).toBe("top");
    expect(o.sourcePosition).toBe(Position.Bottom);
    expect(o.targetPosition).toBe(Position.Top);
    expect(o.sourceHandle).toBe("s-bottom");
    expect(o.targetHandle).toBe("t-top");
  });

  it("connects Top → Bottom when the target is above", () => {
    const o = connectionOrientation({ x: 0, y: 0 }, { x: 0, y: -200 });
    expect(o.sourceSide).toBe("top");
    expect(o.targetSide).toBe("bottom");
    expect(o.sourcePosition).toBe(Position.Top);
    expect(o.targetPosition).toBe(Position.Bottom);
  });

  it("picks the dominant axis on diagonals", () => {
    // Horizontal-dominant diagonal stays horizontal.
    const h = connectionOrientation({ x: 0, y: 0 }, { x: 100, y: 60 });
    expect(h.sourceSide).toBe("right");
    expect(h.targetSide).toBe("left");
    // Vertical-dominant diagonal goes vertical (60*1.25 = 75 < 100).
    const v = connectionOrientation({ x: 0, y: 0 }, { x: 60, y: 100 });
    expect(v.sourceSide).toBe("bottom");
    expect(v.targetSide).toBe("top");
    // Vertical-dominant, target above-left.
    const vu = connectionOrientation({ x: 0, y: 0 }, { x: -60, y: -100 });
    expect(vu.sourceSide).toBe("top");
    expect(vu.targetSide).toBe("bottom");
  });

  it("resolves coincident points to the horizontal default", () => {
    const o = connectionOrientation({ x: 42, y: 42 }, { x: 42, y: 42 });
    expect(o.sourceSide).toBe("right");
    expect(o.targetSide).toBe("left");
  });

  it("resolves near-coincident jitter within the tie band to horizontal", () => {
    const o = connectionOrientation({ x: 0, y: 0 }, { x: 3, y: 3 });
    expect(o.sourceSide).toBe("right");
    expect(o.targetSide).toBe("left");
  });

  it("keeps a slightly-vertical diagonal horizontal inside the tie band", () => {
    // dy dominates dx but not by VERTICAL_DOMINANCE → stays horizontal.
    const o = connectionOrientation({ x: 0, y: 0 }, { x: 100, y: 110 });
    expect(o.sourceSide).toBe("right");
    expect(o.targetSide).toBe("left");
  });

  it("flips to vertical exactly past the dominance threshold", () => {
    const at = connectionOrientation(
      { x: 0, y: 0 },
      { x: 100, y: 100 * VERTICAL_DOMINANCE },
    );
    expect(at.sourceSide).toBe("right"); // strict > : the boundary itself is horizontal
    const past = connectionOrientation(
      { x: 0, y: 0 },
      { x: 100, y: 100 * VERTICAL_DOMINANCE + 1 },
    );
    expect(past.sourceSide).toBe("bottom");
    expect(past.targetSide).toBe("top");
  });

  it("treats a shared x column as vertical", () => {
    expect(
      connectionOrientation({ x: 10, y: 0 }, { x: 10, y: 50 }).sourceSide,
    ).toBe("bottom");
    expect(
      connectionOrientation({ x: 10, y: 50 }, { x: 10, y: 0 }).sourceSide,
    ).toBe("top");
  });

  it("keeps sides, positions, and handle ids mutually consistent", () => {
    const cases: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
      [
        { x: 0, y: 0 },
        { x: 300, y: 0 },
      ],
      [
        { x: 0, y: 0 },
        { x: -300, y: 0 },
      ],
      [
        { x: 0, y: 0 },
        { x: 0, y: 300 },
      ],
      [
        { x: 0, y: 0 },
        { x: 0, y: -300 },
      ],
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
    ];
    for (const [a, b] of cases) {
      const o = connectionOrientation(a, b);
      expect(o.sourcePosition).toBe(SIDE_POSITION[o.sourceSide]);
      expect(o.targetPosition).toBe(SIDE_POSITION[o.targetSide]);
      expect(o.sourceHandle).toBe(sourceHandleId(o.sourceSide));
      expect(o.targetHandle).toBe(targetHandleId(o.targetSide));
      expect(o.sourceHandle).toBe(`s-${o.sourceSide}`);
      expect(o.targetHandle).toBe(`t-${o.targetSide}`);
      // Opposite sides of the two nodes always face each other.
      expect(new Set([o.sourceSide, o.targetSide]).size).toBe(2);
    }
  });

  it("exposes a horizontal default orientation", () => {
    expect(DEFAULT_ORIENTATION.sourceSide).toBe("right");
    expect(DEFAULT_ORIENTATION.targetSide).toBe("left");
    expect(DEFAULT_ORIENTATION.sourceHandle).toBe("s-right");
    expect(DEFAULT_ORIENTATION.targetHandle).toBe("t-left");
  });
});
