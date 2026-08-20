/**
 * zoomTiers.ts — zoom-density policy for canvas text.
 *
 * React Flow scales the whole viewport with zoom, so all label/readout
 * wrappers counter-scale by `1 / zoom` to stay a constant SCREEN size
 * (see the label wrappers in CustomNode / CustomEdge / GroupContainer).
 * To keep big networks legible, text then disappears by density tier as
 * the user zooms out — the font never shrinks, it only declutters.
 *
 * Dense graphs (many elements) escalate the names→sparse threshold so the
 * overview zoom level isn't a wall of overlapping chips; a screen-space
 * overlap-culling pass (labelLayout.ts) then keeps the survivors distinct.
 */

export type ZoomTier = "full" | "names" | "sparse" | "hidden";

/** zoom >= FULL: names + live result chips + secondary metrics. */
export const ZOOM_TIER_FULL = 0.75;
/** zoom >= NAMES: component/node names only (compact chips, no readouts). */
const ZOOM_TIER_NAMES = 0.45;
/** Dense-graph names threshold (models above DENSE_ELEMENT_COUNT). */
const ZOOM_TIER_NAMES_DENSE = 0.6;
/** zoom >= SPARSE: only selected/hovered names, boundary and subnetwork labels. */
const ZOOM_TIER_SPARSE = 0.3;
/** below SPARSE: selected element names and subnetwork labels only. */

/** Element count (nodes + edges) above which a graph is "dense". */
export const DENSE_ELEMENT_COUNT = 50;

export function zoomTier(zoom: number, dense = false): ZoomTier {
  if (zoom >= ZOOM_TIER_FULL) return "full";
  const namesThreshold = dense ? ZOOM_TIER_NAMES_DENSE : ZOOM_TIER_NAMES;
  if (zoom >= namesThreshold) return "names";
  if (zoom >= ZOOM_TIER_SPARSE) return "sparse";
  return "hidden";
}

/** Inverse-zoom CSS transform that keeps an element screen-size invariant. */
export function counterScale(zoom: number): string {
  return `scale(${1 / zoom})`;
}

/**
 * Whether a node's name is drawn this frame — the single policy CustomNode and
 * CustomSolidNode share.
 *
 * `showLabels` (the canvas labels toggle, which governs all element text — see
 * the store) is absolute: it outranks selection, because the user asked for a
 * clean drawing and the property panel already names the selection, and a lone
 * surviving name would defeat the point. Below it is the density ladder: names
 * show freely while zoomed in, survive at `sparse` only for elements the user is
 * pointing at (plus `pinned` ones — boundaries and ambients, which carry the
 * drawing's inputs), and at `hidden` only for the selection.
 */
export function showsNodeName(opts: {
  tier: ZoomTier;
  /** Canvas labels toggle. */
  showLabels: boolean;
  selected: boolean;
  hovered: boolean;
  /** Boundary/ambient node: keeps its name one tier longer than the rest. */
  pinned: boolean;
  /** Screen-space declutter verdict from labelLayout. */
  culled: boolean;
}): boolean {
  const { tier, showLabels, selected, hovered, pinned, culled } = opts;
  if (!showLabels) return false;
  switch (tier) {
    // Full detail never culls: the layout pass only aggregates at this tier.
    case "full":
      return true;
    case "names":
      return selected || !culled;
    case "sparse":
      return selected || hovered || pinned;
    case "hidden":
      return selected;
  }
}

/**
 * Whether a node's readout chip — solved pressure/temperature, or the
 * pre-run boundary condition — is drawn this frame.
 *
 * Readouts are the densest text on the drawing, so they are full-detail only,
 * and the labels toggle takes them along with the names: hiding names but
 * leaving values would still bury the schematic in text.
 */
export function showsNodeChip(opts: {
  tier: ZoomTier;
  /** Canvas labels toggle. */
  showLabels: boolean;
  /** False when the node has neither a result nor a boundary condition to show. */
  hasContent: boolean;
}): boolean {
  return opts.showLabels && opts.tier === "full" && opts.hasContent;
}
