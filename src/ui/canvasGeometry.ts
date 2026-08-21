/**
 * canvasGeometry — single source of truth for the RENDERED dimensions of
 * canvas elements and the centers/label anchors derived from them.
 *
 * FlowCanvas picks per-edge connection sides from node centers, so the sizes
 * here MUST match the glyphs rendered by CustomNode / CustomSolidNode /
 * GroupContainer — this module is the contract between edge geometry and the
 * node components.
 *
 * Glyph set: the compact P&ID look — small junction-dot / rounded-square /
 * diamond nodes with straight pipe runs and on-line component symbols. All
 * derived anchors (labels, focus, declutter estimates, edge-chip offset)
 * are computed from the sizes below, never hardcoded elsewhere.
 *
 * Helpers take structural {x, y, …} inputs so this module stays free of core
 * schema imports and is trivially testable.
 */
import type { CanvasPoint } from "./connectionGeometry";

// ── Rendered sizes (compact P&ID glyph set) ──────────────────────────────

/** Boundary fluid node glyph (rounded square), px. */
export const FLUID_BOUNDARY_SIZE = 26;
/** Internal fluid node glyph (circle / junction dot), px. */
export const FLUID_INTERNAL_SIZE = 22;
/** Solid/ambient node glyph (diamond), px. */
export const SOLID_NODE_SIZE = 26;
/** Group container box, px. */
export const GROUP_WIDTH = 140;
export const GROUP_HEIGHT = 80;
/**
 * Canvas note card, px.  NOTE_WIDTH / NOTE_MIN_HEIGHT are the DEFAULT box of a
 * freshly placed note, which grows downward with its text; once the user drags
 * the resize handle the note carries its own explicit width/height instead.
 * The minimums are what the resize handle clamps to — small enough for a
 * one-word margin note, large enough to stay grabbable.
 */
export const NOTE_WIDTH = 180;
export const NOTE_MIN_HEIGHT = 60;
export const NOTE_MIN_WIDTH = 90;

/** Rendered box of a note, falling back to the default/auto size. */
export const noteSize = (note: {
  width?: number;
  height?: number;
}): { width: number; height: number } => ({
  width: note.width ?? NOTE_WIDTH,
  height: note.height ?? NOTE_MIN_HEIGHT,
});
/** Background and placement grid spacing, px. */
export const CANVAS_GRID_SIZE = 15;

// ── Label anchors ────────────────────────────────────────────────────────

/**
 * Flow-space gap between the bottom of a node glyph and its name/chip label
 * stack (`top = size + NODE_LABEL_GAP` in the node components).
 */
export const NODE_LABEL_GAP = 3;
/** Ghost nodes (external endpoints in a group tab) sit one px closer. */
export const GHOST_LABEL_GAP = 2;

/**
 * Flow-space y offsets of the label anchor used by the screen-space label
 * declutter (FlowCanvas labelLayout) when only the node KIND is known.
 * These are the per-kind maxima (boundary glyphs are the largest fluid
 * nodes) — a declutter estimate, not an exact anchor. Prefer
 * fluidNodeLabelOffsetY(type) when the concrete type is at hand.
 */
export const FLUID_NODE_LABEL_OFFSET_Y =
  FLUID_BOUNDARY_SIZE + NODE_LABEL_GAP + 1;
export const SOLID_NODE_LABEL_OFFSET_Y = SOLID_NODE_SIZE + NODE_LABEL_GAP + 1;

// ── Edge (pipe-run) geometry ─────────────────────────────────────────────

/**
 * Flow-space size of the P&ID component symbol drawn on the midpoint of a
 * fluid branch / conductor run (see PidEdgeSymbol in PidSymbol.tsx).
 */
export const EDGE_GLYPH_SIZE = 22;
/** Run length (flow px) below which the on-line glyph is omitted entirely. */
export const EDGE_GLYPH_MIN_RUN = 34;
/** Run length (flow px) at or above which the glyph renders full size. */
export const EDGE_GLYPH_FULL_RUN = 72;
/**
 * SCREEN-space perpendicular distance from the run midpoint to the edge
 * result chip (px). The chip sits beside the line, never on the symbol.
 */
// Clear the centered P&ID glyph and its hit area before placing a readout.
export const EDGE_CHIP_OFFSET = 32;
/** Invisible interaction width around an edge path (px) — generous click target. */
export const EDGE_INTERACTION_WIDTH = 24;

// ── Structural inputs ────────────────────────────────────────────────────

export interface FluidNodeLike {
  x: number;
  y: number;
  type: "boundary" | "internal";
}
export interface SolidNodeLike {
  x: number;
  y: number;
}
export interface GroupLike {
  x: number;
  y: number;
}

// ── Node/group geometry ──────────────────────────────────────────────────

/** Rendered square size of a fluid node glyph. */
export const fluidNodeSize = (type: FluidNodeLike["type"]): number =>
  type === "boundary" ? FLUID_BOUNDARY_SIZE : FLUID_INTERNAL_SIZE;

/** Center of a rendered fluid node (drives edge side selection). */
export const fluidNodeCenter = (n: FluidNodeLike): CanvasPoint => {
  const s = fluidNodeSize(n.type);
  return { x: n.x + s / 2, y: n.y + s / 2 };
};

/** Center of a rendered solid/ambient node. */
export const solidNodeCenter = (n: SolidNodeLike): CanvasPoint => ({
  x: n.x + SOLID_NODE_SIZE / 2,
  y: n.y + SOLID_NODE_SIZE / 2,
});

/** Center of a rendered group container. */
export const groupCenter = (g: GroupLike): CanvasPoint => ({
  x: g.x + GROUP_WIDTH / 2,
  y: g.y + GROUP_HEIGHT / 2,
});

/** Inverse of groupCenter: top-left position for a container centered at (cx, cy). */
export const groupOriginForCenter = (cx: number, cy: number): CanvasPoint => ({
  x: cx - GROUP_WIDTH / 2,
  y: cy - GROUP_HEIGHT / 2,
});

/** Top-left origin that puts an element's center on the nearest grid point. */
export const snapOriginToGrid = (
  origin: CanvasPoint,
  width: number,
  height: number,
  grid = CANVAS_GRID_SIZE,
): CanvasPoint => ({
  x: Math.round((origin.x + width / 2) / grid) * grid - width / 2,
  y: Math.round((origin.y + height / 2) / grid) * grid - height / 2,
});

/**
 * Snap a top-left origin straight onto the grid.  For an element whose stored
 * position IS its corner and whose size the user can change (a note card),
 * snapping the corner is the stable choice: snapping the CENTER instead leaves
 * a half-grid residue on odd sizes, and re-snapping walks the element downhill
 * every time it is touched.
 */
export const snapPointToGrid = (
  point: CanvasPoint,
  grid = CANVAS_GRID_SIZE,
): CanvasPoint => ({
  x: Math.round(point.x / grid) * grid,
  y: Math.round(point.y / grid) * grid,
});

/** Top-left origin for an element dropped with its center at a pointer point. */
export const gridOriginForCenter = (
  center: CanvasPoint,
  width: number,
  height: number,
  grid = CANVAS_GRID_SIZE,
): CanvasPoint => ({
  x: Math.round(center.x / grid) * grid - width / 2,
  y: Math.round(center.y / grid) * grid - height / 2,
});

// ── Label anchors ────────────────────────────────────────────────────────

/** Flow-space `top` of a node's name/chip label stack (just below the glyph). */
export const nodeLabelTop = (nodeSize: number): number =>
  nodeSize + NODE_LABEL_GAP;

/** Ghost nodes anchor their label one px closer to the glyph. */
export const ghostLabelTop = (nodeSize: number): number =>
  nodeSize + GHOST_LABEL_GAP;

/**
 * Exact flow-space y offset of a fluid node's label anchor, per node type —
 * used by the screen-space declutter so the estimate tracks rendered sizes.
 */
export const fluidNodeLabelOffsetY = (type: FluidNodeLike["type"]): number =>
  nodeLabelTop(fluidNodeSize(type)) + 1;

// ── Edge run geometry ────────────────────────────────────────────────────

export interface EdgeRun {
  /** Run length in flow px. */
  length: number;
  /** Run direction (source → target) in degrees, screen coords (+y down). */
  angleDeg: number;
  /** Midpoint of the run, flow px. */
  midX: number;
  midY: number;
  /** Unit normal to the run, pointing to the chip side. Zero-length runs
   *  fall back to straight down. */
  normalX: number;
  normalY: number;
}

/**
 * Straight-run geometry between two edge anchor points: length, direction,
 * midpoint and the unit normal used to offset the result chip. Pure — the
 * same numbers drive the on-line symbol transform and the chip placement,
 * so they can never disagree.
 */
export function edgeRun(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): EdgeRun {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy);
  const angleDeg = length > 1e-9 ? (Math.atan2(dy, dx) * 180) / Math.PI : 0;
  const normalX = length > 1e-9 ? -dy / length : 0;
  const normalY = length > 1e-9 ? dx / length : 1;
  return {
    length,
    angleDeg,
    midX: (sourceX + targetX) / 2,
    midY: (sourceY + targetY) / 2,
    normalX,
    normalY,
  };
}

/**
 * On-line glyph scale for a run: 0 hides the glyph (run too short to carry
 * a symbol without overlapping the node glyphs at the ends); otherwise the
 * glyph grows linearly from the minimum run to full size.
 */
export function edgeGlyphScale(runLength: number): number {
  if (runLength < EDGE_GLYPH_MIN_RUN) return 0;
  return Math.min(1, runLength / EDGE_GLYPH_FULL_RUN);
}
