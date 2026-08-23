/**
 * dropPosition.ts — pick where NEW canvas elements land.
 *
 * New nodes spiral out from the viewport centre, but never into screen
 * regions occupied by floating canvas UI (creation tools on the left,
 * contextual properties on the right, and the Global Map card bottom-right), so a
 * freshly added node is never born underneath a panel.
 */
import { useStore } from "./store";
import { findFreePosition, loadGlobalMapOpen, FlowRect } from "./utils";

/** Screen-space rectangles (px from the canvas pane's top-left) to avoid. */
function blockedScreenRects(
  paneW: number,
  paneH: number,
  globalMapOpen: boolean,
): FlowRect[] {
  const rects: FlowRect[] = [
    // Floating creation rail (icon-only). In the Studio shell the canvas
    // pane is flanked by the outline and inspector DOCKS, which sit outside
    // the pane — only the rail itself overlays it on the left.
    { x0: -20, y0: -20, x1: 96, y1: paneH + 20 },
    // Top-right view controls (color-by chip, 3D controls).
    { x0: paneW - 260, y0: -20, x1: paneW + 20, y1: paneH + 20 },
  ];
  if (globalMapOpen) {
    // Expanded global map card (MiniMap ~200x150 + header + padding)
    rects.push({
      x0: paneW - 250,
      y0: paneH - 215,
      x1: paneW + 20,
      y1: paneH + 20,
    });
  } else {
    // Collapsed map chip
    rects.push({
      x0: paneW - 130,
      y0: paneH - 64,
      x1: paneW + 20,
      y1: paneH + 20,
    });
  }
  return rects;
}

/** Free drop position in flow coordinates for the main visible canvas. */
export function canvasDropPosition(): { x: number; y: number } {
  const { config, canvasViewport: vp } = useStore.getState();
  const pane = document.querySelector('[data-testid="flow-canvas"]');
  const w = pane?.clientWidth ?? 800;
  const h = pane?.clientHeight ?? 600;
  const zoom = vp.zoom || 1;

  const toFlowX = (sx: number) => (sx - vp.x) / zoom;
  const toFlowY = (sy: number) => (sy - vp.y) / zoom;
  // Pad the blocked region downward in flow space so node labels (which hang
  // ~40 screen px below the glyph) also clear the floating UI.
  const labelPad = 48 / zoom;
  const blocked = blockedScreenRects(w, h, loadGlobalMapOpen()).map((r) => ({
    x0: toFlowX(r.x0),
    y0: toFlowY(r.y0),
    x1: toFlowX(r.x1),
    y1: toFlowY(r.y1) + labelPad,
  }));

  const taken = [
    ...config.nodes.map((n) => ({ x: n.x, y: n.y })),
    ...(config.solidNodes ?? []).map((n) => ({ x: n.x, y: n.y })),
    ...(config.groups ?? []).map((g) => ({ x: g.x, y: g.y })),
    ...(config.notes ?? []).map((n) => ({ x: n.x, y: n.y })),
  ];
  return findFreePosition(taken, toFlowX(w / 2), toFlowY(h / 2), blocked);
}
