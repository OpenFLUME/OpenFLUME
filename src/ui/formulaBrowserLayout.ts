/**
 * formulaBrowserLayout — pure placement math for the click-first formula
 * browser popover (components/FormulaBrowser.tsx).
 *
 * The popover is `position: fixed`, so every number here is in viewport
 * coordinates (px). There are two placements:
 *
 *  - ANCHORED (default): right-aligned under the f(x) button, flipping above
 *    it when the room below is too short to be usable.
 *  - DRAGGED: the user moved the panel by its header, so only the clamp
 *    applies and the anchor is no longer consulted.
 *
 * Both cap `maxHeight` to the room actually available, so a panel opened near
 * the bottom of the window can never run off screen — its body scrolls
 * instead. The drag clamp keeps the header on screen for the same reason.
 */

/** The part of a DOMRect the placement needs (a DOMRect satisfies this). */
export interface AnchorRect {
  top: number;
  bottom: number;
  right: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Top-left corner of the panel in viewport coordinates. */
export interface BrowserPosition {
  left: number;
  top: number;
}

/**
 * Resolved geometry, ready to spread into a style object. Exactly one of
 * `top` / `bottom` is present: an upward-flipped panel grows from the anchor
 * so it stays put when its content changes height.
 */
export interface BrowserPlacement {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/** Gap kept between the panel and the viewport edges. */
const MARGIN = 8;
/** Gap between the panel and its anchor. */
const GAP = 6;
/** Widest the panel gets before the viewport constrains it. */
const MAX_WIDTH = 420;
/** Tallest the panel gets before the available room constrains it. */
const MAX_HEIGHT = 520;
/**
 * Height the panel always keeps, even when that overflows a very short
 * viewport — a panel squeezed below this is unusable, and it is also the
 * amount a dragged panel must keep on screen.
 */
const MIN_HEIGHT = 200;
/** Below this much room under the anchor, prefer opening upward. */
const FLIP_BELOW = 300;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function formulaBrowserWidth(viewport: Viewport): number {
  return Math.min(MAX_WIDTH, viewport.width - 2 * MARGIN);
}

/** Left edge that keeps the panel on screen, preferring anchor right-alignment. */
function alignedLeft(
  anchorRight: number,
  width: number,
  viewport: Viewport,
): number {
  return clamp(
    anchorRight - width,
    MARGIN,
    Math.max(MARGIN, viewport.width - width - MARGIN),
  );
}

function usableHeight(room: number): number {
  return clamp(room, MIN_HEIGHT, MAX_HEIGHT);
}

/** Placement pinned to the f(x) button that opened the browser. */
export function anchoredPlacement(
  anchor: AnchorRect,
  viewport: Viewport,
): BrowserPlacement {
  const width = formulaBrowserWidth(viewport);
  const left = alignedLeft(anchor.right, width, viewport);
  const roomBelow = viewport.height - anchor.bottom - GAP - MARGIN;
  const roomAbove = anchor.top - GAP - MARGIN;
  if (roomBelow < FLIP_BELOW && roomAbove > roomBelow) {
    return {
      left,
      width,
      bottom: viewport.height - anchor.top + GAP,
      maxHeight: usableHeight(roomAbove),
    };
  }
  return {
    left,
    width,
    top: anchor.bottom + GAP,
    maxHeight: usableHeight(roomBelow),
  };
}

/** Keep a dragged panel fully on screen, header first. */
export function clampBrowserPosition(
  position: BrowserPosition,
  viewport: Viewport,
): BrowserPosition {
  const width = formulaBrowserWidth(viewport);
  return {
    left: clamp(
      position.left,
      MARGIN,
      Math.max(MARGIN, viewport.width - width - MARGIN),
    ),
    top: clamp(
      position.top,
      MARGIN,
      Math.max(MARGIN, viewport.height - MIN_HEIGHT - MARGIN),
    ),
  };
}

/** Placement for a panel the user has dragged somewhere. */
export function draggedPlacement(
  position: BrowserPosition,
  viewport: Viewport,
): BrowserPlacement {
  const { left, top } = clampBrowserPosition(position, viewport);
  return {
    left,
    top,
    width: formulaBrowserWidth(viewport),
    maxHeight: usableHeight(viewport.height - top - MARGIN),
  };
}
