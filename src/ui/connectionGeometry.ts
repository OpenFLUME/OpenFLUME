/**
 * connectionGeometry — geometry-aware edge anchoring.
 *
 * Root-cause context: React Flow anchors an edge to a node's FIRST handle of
 * each type when the edge carries no handle ids, and the node components
 * declare a source handle at Bottom and a target handle at Top first — so
 * every edge used to exit the bottom of its source and enter the top of its
 * target, even in left→right diagrams. This helper picks the connection sides
 * from the relative geometry of the two endpoints instead, and the canvas
 * passes the matching handle ids on every edge.
 *
 * Axis choice is dominant-axis with a modest tie band: the vertical axis must
 * dominate by VERTICAL_DOMINANCE before a connection turns vertical, and
 * near-ties resolve horizontal (most network diagrams read left→right). The
 * band acts as hysteresis: once an edge is horizontal, the vertical offset
 * must grow well past the 45° diagonal to flip it, so dragging a node across
 * the diagonal doesn't make the edge chatter between sides.
 *
 * Pure and deterministic: same positions in → same sides out.
 */
import { Position } from "@xyflow/react";

export type Side = "top" | "right" | "bottom" | "left";

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface ConnectionOrientation {
  sourceSide: Side;
  targetSide: Side;
  sourcePosition: Position;
  targetPosition: Position;
  sourceHandle: string;
  targetHandle: string;
}

/** Vertical must dominate horizontal by this factor to choose Top/Bottom. */
export const VERTICAL_DOMINANCE = 1.25;

export const SIDE_POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/** Handle ids must match the <Handle id={...}> set rendered by every node. */
export const sourceHandleId = (side: Side): string => `s-${side}`;
export const targetHandleId = (side: Side): string => `t-${side}`;

function orientation(
  sourceSide: Side,
  targetSide: Side,
): ConnectionOrientation {
  return {
    sourceSide,
    targetSide,
    sourcePosition: SIDE_POSITION[sourceSide],
    targetPosition: SIDE_POSITION[targetSide],
    sourceHandle: sourceHandleId(sourceSide),
    targetHandle: targetHandleId(targetSide),
  };
}

/** Fallback when geometry is unavailable — the common left→right reading. */
export const DEFAULT_ORIENTATION: ConnectionOrientation = orientation(
  "right",
  "left",
);

/**
 * Pick the sides a source→target connection should leave/enter, given the two
 * node CENTERS in canvas (screen) coordinates. Note +y points DOWN on screen,
 * so a target below its source has dy > 0 and connects Bottom→Top.
 */
export function connectionOrientation(
  source: CanvasPoint,
  target: CanvasPoint,
): ConnectionOrientation {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (Math.abs(dy) > Math.abs(dx) * VERTICAL_DOMINANCE) {
    return dy > 0 ? orientation("bottom", "top") : orientation("top", "bottom");
  }
  return dx >= 0 ? orientation("right", "left") : orientation("left", "right");
}
