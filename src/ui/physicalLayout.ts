/**
 * physicalLayout — resolves every canvas element to a physical point in the
 * z-up lab frame so the 3D view has something to project.
 *
 * The model carries two independent coordinate systems: canvas `x`/`y` are
 * schematic PIXELS (grid-snapped, never solver input) while `position
 * {x,y,z}` is optional physical METRES.  Most authored models set only
 * `position.x`, and many set nothing at all, so a literal physical renderer
 * would collapse them to a line or drop them entirely.
 *
 * This module therefore falls back PER AXIS:
 *
 *   physical x  ←  position.x   else  canvasX * metresPerPixel
 *   physical z  ←  position.z   else −canvasY * metresPerPixel   (z is up,
 *                                     screen y grows down)
 *   physical y  ←  position.y   else  0                          (depth)
 *
 * Two consequences make the 2D/3D toggle legible.  Inferred coordinates land
 * on the same scale as real ones, so the two mix without a visible seam; and
 * at the Front camera an all-inferred model projects back to exactly its
 * schematic layout, so entering 3D reads as tilting the familiar diagram
 * rather than jumping to an unrecognizable scene.
 *
 * Formula-bound axes (`{ expr }`) count as unset here: resolving them needs
 * the parameter-binding pass, which is not a view concern.  They fall back
 * and are reported as inferred.
 */
import type { PhysicalPosition } from "../core";
import {
  fluidNodeCenter,
  solidNodeCenter,
  SOLID_NODE_SIZE,
  fluidNodeSize,
} from "./canvasGeometry";
import {
  project,
  type Camera3D,
  type Point3,
  type ProjectedPoint,
} from "./projection3d";

/**
 * Metres per schematic pixel used when the model gives no way to derive a
 * scale.  At the 170 px column pitch written by the current builders this is
 * an ~8.5 m spacing between adjacent nodes — plant scale, so inferred depth
 * and real depth stay comparable.
 */
export const DEFAULT_METRES_PER_PIXEL = 0.05;

export interface PositionedElement {
  id: string;
  /** Schematic pixels (top-left origin). */
  x: number;
  y: number;
  position?: PhysicalPosition;
}

export interface FluidElement extends PositionedElement {
  type: "boundary" | "internal";
}

export interface PhysicalPlacement extends Point3 {
  /** Which axes were filled from the schematic rather than authored. */
  inferred: { x: boolean; y: boolean; z: boolean };
}

export interface PhysicalLayout {
  /** Physical centre of every element, keyed by element id. */
  placements: Map<string, PhysicalPlacement>;
  /** Half-size (px) of each element's glyph, for centre↔origin conversion. */
  halfSizes: Map<string, number>;
  metresPerPixel: number;
  /** Rotation centre, so orbiting spins the model in place. */
  pivot: Point3;
  /** Schematic centroid (px) the projection is anchored to. */
  origin: { x: number; y: number };
}

export interface ScreenPlacement extends ProjectedPoint {
  /** Normalized depth across the model: 0 nearest, 1 farthest. */
  t: number;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function span(values: number[]): number {
  if (values.length < 2) return 0;
  return Math.max(...values) - Math.min(...values);
}

/**
 * Metres per pixel implied by the model itself: if enough elements carry a
 * real `position.x`, the ratio of the physical x-span to the schematic x-span
 * puts inferred coordinates on the authored scale.  Falls back to the
 * constant when the model has no physical extent to measure.
 */
export function deriveMetresPerPixel(elements: PositionedElement[]): number {
  const paired = elements
    .map((el) => ({ physical: finite(el.position?.x), canvas: el.x }))
    .filter(
      (p): p is { physical: number; canvas: number } =>
        p.physical !== undefined,
    );
  const physicalSpan = span(paired.map((p) => p.physical));
  const canvasSpan = span(paired.map((p) => p.canvas));
  if (physicalSpan > 0 && canvasSpan > 0) return physicalSpan / canvasSpan;
  return DEFAULT_METRES_PER_PIXEL;
}

/**
 * Resolve one element's physical centre.  `centre` is the element's rendered
 * centre in schematic pixels, which is what the projection needs — using the
 * stored top-left origin instead would rotate the model about a half-glyph
 * offset.
 */
function placementFor(
  position: PhysicalPosition | undefined,
  centre: { x: number; y: number },
  metresPerPixel: number,
): PhysicalPlacement {
  const px = finite(position?.x);
  const py = finite(position?.y);
  const pz = finite(position?.z);
  return {
    x: px ?? centre.x * metresPerPixel,
    y: py ?? 0,
    z: pz ?? -centre.y * metresPerPixel,
    inferred: { x: px === undefined, y: py === undefined, z: pz === undefined },
  };
}

/**
 * Build the physical layout for the elements currently on a canvas.  Takes
 * the visible sets rather than a whole config so a group/subnetwork tab
 * pivots about its own members instead of the whole plant.
 */
export function physicalLayout(input: {
  nodes: FluidElement[];
  solidNodes: PositionedElement[];
}): PhysicalLayout {
  const { nodes, solidNodes } = input;
  const metresPerPixel = deriveMetresPerPixel([...nodes, ...solidNodes]);

  const placements = new Map<string, PhysicalPlacement>();
  const halfSizes = new Map<string, number>();
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let sumCanvasX = 0;
  let sumCanvasY = 0;

  const add = (
    id: string,
    centre: { x: number; y: number },
    position: PhysicalPosition | undefined,
    half: number,
  ) => {
    const placement = placementFor(position, centre, metresPerPixel);
    placements.set(id, placement);
    halfSizes.set(id, half);
    sumX += placement.x;
    sumY += placement.y;
    sumZ += placement.z;
    sumCanvasX += centre.x;
    sumCanvasY += centre.y;
  };

  for (const node of nodes) {
    add(
      node.id,
      fluidNodeCenter(node),
      node.position,
      fluidNodeSize(node.type) / 2,
    );
  }
  for (const solid of solidNodes) {
    add(solid.id, solidNodeCenter(solid), solid.position, SOLID_NODE_SIZE / 2);
  }

  const count = placements.size || 1;
  return {
    placements,
    halfSizes,
    metresPerPixel,
    pivot: { x: sumX / count, y: sumY / count, z: sumZ / count },
    origin: { x: sumCanvasX / count, y: sumCanvasY / count },
  };
}

/**
 * Project a layout to schematic-pixel centres for a given camera.
 *
 * Scaling by the inverse of `metresPerPixel` is what makes the Front camera
 * an exact identity on inferred coordinates, and it keeps projected spacing
 * in the same pixel range as the 2D canvas so React Flow's existing zoom,
 * fitView, and glyph sizes stay calibrated.
 */
export function projectLayout(
  layout: PhysicalLayout,
  camera: Camera3D,
): Map<string, ScreenPlacement> {
  const { placements, pivot, origin, metresPerPixel } = layout;
  const pixelsPerMetre =
    metresPerPixel > 0 ? 1 / metresPerPixel : 1 / DEFAULT_METRES_PER_PIXEL;

  const projected = new Map<string, ProjectedPoint>();
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (const [id, placement] of placements) {
    const point = project(
      {
        x: placement.x - pivot.x,
        y: placement.y - pivot.y,
        z: placement.z - pivot.z,
      },
      camera,
    );
    projected.set(id, point);
    if (point.depth < minDepth) minDepth = point.depth;
    if (point.depth > maxDepth) maxDepth = point.depth;
  }

  const depthRange = maxDepth - minDepth;
  const out = new Map<string, ScreenPlacement>();
  for (const [id, point] of projected) {
    out.set(id, {
      x: origin.x + point.x * pixelsPerMetre,
      y: origin.y + point.y * pixelsPerMetre,
      depth: point.depth,
      t: depthRange > 1e-9 ? (point.depth - minDepth) / depthRange : 0,
    });
  }
  return out;
}
