/**
 * projection3d — the orthographic camera behind the canvas 3D view.
 *
 * Pure geometry: physical metres in the z-up lab frame go in, screen-basis
 * metres plus a depth scalar come out.  Nothing here knows about pixels,
 * React Flow, or the schema — the caller scales by its own pixels-per-metre
 * (see physicalLayout.ts) and decides what depth means visually.
 *
 * Orientation contract (the reason the 2D and 3D views are comparable): at
 * the identity camera (yaw 0, pitch 0) screen x is physical x and screen y is
 * physical −z, because screen y grows downward while elevation grows up.  A
 * model whose physical coordinates were inferred from the schematic therefore
 * projects back to exactly its schematic layout at the Front preset.
 */

/** Camera orientation in degrees.  Yaw spins about the up axis (z), pitch
 *  lifts the camera above the horizon (+90 looks straight down). */
export interface Camera3D {
  yaw: number;
  pitch: number;
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface ProjectedPoint {
  /** Screen right, in the same length unit as the input. */
  x: number;
  /** Screen down, in the same length unit as the input. */
  y: number;
  /** Distance along the view direction; larger is farther from the camera. */
  depth: number;
}

export type ViewPresetId = "front" | "top" | "side" | "iso";

/**
 * Named camera orientations.  `front` is the identity that reproduces the
 * schematic layout; `iso` is a three-quarter axonometric (not the strict
 * 35.264° isometric) chosen so a mostly-planar network still reads clearly
 * while genuine depth separates.
 */
export const VIEW_PRESETS: Record<ViewPresetId, Camera3D> = {
  front: { yaw: 0, pitch: 0 },
  top: { yaw: 0, pitch: 90 },
  side: { yaw: 90, pitch: 0 },
  iso: { yaw: 35, pitch: 25 },
};

export const VIEW_PRESET_ORDER: ViewPresetId[] = [
  "iso",
  "front",
  "top",
  "side",
];

export const VIEW_PRESET_LABELS: Record<ViewPresetId, string> = {
  front: "Front",
  top: "Top",
  side: "Side",
  iso: "Iso",
};

/** Entering the 3D view lands here: a gentle tilt of the familiar schematic. */
export const DEFAULT_CAMERA: Camera3D = VIEW_PRESETS.iso;

const DEG = Math.PI / 180;

/** Straight down and straight up are both usable; beyond them the view flips. */
export function clampPitch(pitch: number): number {
  return Math.min(90, Math.max(-90, pitch));
}

/** Wrap yaw into (−180, 180] so the readout never drifts to 3600°. */
export function normalizeYaw(yaw: number): number {
  const wrapped = ((((yaw + 180) % 360) + 360) % 360) - 180;
  // −180 and 180 are the same orientation; prefer the positive end.
  return wrapped === -180 ? 180 : wrapped;
}

export function normalizeCamera(camera: Camera3D): Camera3D {
  return { yaw: normalizeYaw(camera.yaw), pitch: clampPitch(camera.pitch) };
}

/** True iff the camera is the identity, i.e. the projection is a no-op. */
export function isFrontCamera(camera: Camera3D): boolean {
  return normalizeYaw(camera.yaw) === 0 && clampPitch(camera.pitch) === 0;
}

interface Basis {
  right: Point3;
  up: Point3;
  forward: Point3;
}

/**
 * Orthonormal screen basis for a camera.  Yaw rotates `right`/`forward` in
 * the horizontal plane about the fixed up axis; pitch then rotates
 * `up`/`forward` about `right`.  Because the basis is built directly rather
 * than composed from Euler angles there is no gimbal degeneracy at ±90°.
 */
function basisFor(camera: Camera3D): Basis {
  const yaw = normalizeYaw(camera.yaw) * DEG;
  const pitch = clampPitch(camera.pitch) * DEG;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  // Horizontal-plane axes after yaw, with the world up axis untouched.
  const right: Point3 = { x: cy, y: sy, z: 0 };
  const flat: Point3 = { x: -sy, y: cy, z: 0 };
  const up: Point3 = { x: sp * flat.x, y: sp * flat.y, z: cp };
  const forward: Point3 = { x: cp * flat.x, y: cp * flat.y, z: -sp };
  return { right, up, forward };
}

const dot = (a: Point3, b: Point3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Project a physical point to screen-basis coordinates.  Screen y is negated
 * against the up axis so that greater elevation renders higher on screen.
 */
export function project(point: Point3, camera: Camera3D): ProjectedPoint {
  const { right, up, forward } = basisFor(camera);
  return {
    x: dot(point, right),
    y: -dot(point, up),
    depth: dot(point, forward),
  };
}

/**
 * Depth-to-opacity cue.  `t` is the normalized depth (0 nearest, 1 farthest);
 * far elements fade but stay legible and clickable.
 */
export const NEAR_OPACITY = 1;
export const FAR_OPACITY = 0.55;

export function depthOpacity(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return NEAR_OPACITY + (FAR_OPACITY - NEAR_OPACITY) * clamped;
}

/**
 * Painter's-algorithm stacking order: nearer elements sit above farther ones.
 * Kept strictly positive so projected nodes never fall behind React Flow's
 * default edge layer.
 */
export function depthZIndex(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 + Math.round((1 - clamped) * 100);
}
