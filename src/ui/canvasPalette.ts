/**
 * Canvas palette — the one place the diagram's colors are defined.
 *
 * These are the SVG-side twins of the `--*` tokens in index.css. They live in
 * TypeScript because SVG presentation attributes (`fill`, `stroke`) cannot
 * resolve `var()`, and because the MiniMap and the channel-explorer context
 * diagram need the same values as plain strings.
 *
 * Two rules keep the drawing readable:
 *
 *  1. A base color states which NETWORK an element belongs to — fluid (cyan)
 *     or thermal (copper). It never states a magnitude: that is the job of the
 *     color-by ramp in colorData.ts. Copper is the metal of the wall, not a
 *     claim that the wall is hot; the ramp is what says temperature.
 *  2. Amber belongs to selection alone (`--select`). Nothing at rest on the
 *     canvas may be amber, or every wall looks pre-selected.
 */

/* Fluid network — cyan of `--accent` (#197cb4). The primary subject of the
   drawing, so it carries the lightest values. Shape already separates
   internal (circle) from boundary (square); a teal shift marks the ports. */
export const NODE_FLUID = "#2f91c6";
export const NODE_BOUNDARY = "#2fa396";
export const EDGE_BRANCH = "#7e9eae";

/* Thermal network — copper, lifted so dashed ties and diamond nodes still
   read on --bg-0. Distinct from selection gold and from the color-by heat
   ramp; a wall chain should not recede into the canvas. */
export const NODE_SOLID = "#cd8570";
/** Ambient sinks stay darker than solids, but not so dark that the dashed
 *  outline marking them as "the environment" disappears. */
export const NODE_AMBIENT = "#a16353";
/** Matches the solid fill in chroma: a dashed tie already loses optical
 *  weight, so it cannot sit darker than the node it connects. */
export const EDGE_CONDUCTOR = "#d09080";
/** Radiation ties are a redder copper than conduction, still clear of
 *  selection gold. */
export const EDGE_RADIATION = "#d08a68";

/* Structure and non-model elements. */

/** Knockout rim: reads as a gap punched in the drawing, so overlapping runs
 *  and nodes stay separable without a visible black outline. */
export const NODE_OUTLINE = "#131313";
/** Cross-boundary placeholder (a node that lives in another subnetwork). */
export const NODE_GHOST = "#7a7a7a";
/** Collapsed subnetwork container: a cool slab that recedes behind its label. */
export const GROUP_FILL = "#1c2a32";
export const GROUP_LINE = "#3d6273";

/** Text annotation, as the minimap sees it: present in the overview but never
 *  competing with the network (its card colors live in index.css). */
export const NOTE_MINIMAP = "#3a352c";

/** Drafting grid: a fine field with a coarser one over it, both barely
 *  above the canvas background — a grid you can measure against but never
 *  read before the network. */
export const GRID_MINOR = "#2b2b2b";
export const GRID_MAJOR = "#3a3a3a";

/**
 * 3D-view axis triad.  Chrome, not model: these sit in a labelled corner
 * widget beside the letters X/Y/Z, never on the drawing, so they use the
 * conventional CAD red/green/blue that every engineer already reads as the
 * coordinate axes rather than the fluid/thermal families. Rule 2 still holds
 * — none of them is the selection amber. Z tracks the brand cyan.
 */
export const AXIS_X = "#d0605e";
export const AXIS_Y = "#5aa469";
export const AXIS_Z = "#2f91c6";

/** Node fill for the palette rail's legend glyphs and the minimap. */
export function fluidNodeColor(type: string | undefined): string {
  return type === "boundary" ? NODE_BOUNDARY : NODE_FLUID;
}

export function solidNodeColor(type: string | undefined): string {
  return type === "ambient" ? NODE_AMBIENT : NODE_SOLID;
}
