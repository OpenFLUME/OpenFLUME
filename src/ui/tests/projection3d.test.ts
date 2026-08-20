import { describe, it, expect } from "vitest";
import {
  project,
  clampPitch,
  normalizeYaw,
  normalizeCamera,
  isFrontCamera,
  depthOpacity,
  depthZIndex,
  VIEW_PRESETS,
  NEAR_OPACITY,
  FAR_OPACITY,
  type Camera3D,
} from "../projection3d";

const close = (a: number, b: number, tol = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThan(tol);

describe("projection3d preset orientations", () => {
  it("front is the identity: screen x is physical x, screen y is −z, depth is y", () => {
    const p = project({ x: 3, y: 7, z: 2 }, VIEW_PRESETS.front);
    close(p.x, 3);
    close(p.y, -2);
    close(p.depth, 7);
  });

  it("elevation renders higher on screen than the ground at every preset", () => {
    for (const camera of Object.values(VIEW_PRESETS)) {
      if (camera.pitch === 90) continue; // looking straight down, z is depth not height
      const high = project({ x: 0, y: 0, z: 10 }, camera);
      const low = project({ x: 0, y: 0, z: 0 }, camera);
      expect(high.y).toBeLessThan(low.y);
    }
  });

  it("a yaw of 90° swaps the horizontal axes", () => {
    const p = project({ x: 5, y: 9, z: 1 }, { yaw: 90, pitch: 0 });
    close(p.x, 9);
    close(p.y, -1);
    close(p.depth, -5);
  });

  it("top view maps the horizontal plane to the screen and elevation to depth", () => {
    const p = project({ x: 4, y: 6, z: 8 }, VIEW_PRESETS.top);
    close(p.x, 4);
    close(p.y, -6);
    // Straight down: greater elevation is nearer the camera, so smaller depth.
    close(p.depth, -8);
  });

  it("depth ordering is monotonic along the view direction", () => {
    const camera: Camera3D = VIEW_PRESETS.iso;
    const depths = [-20, -5, 0, 5, 20].map(
      (y) => project({ x: 0, y, z: 0 }, camera).depth,
    );
    const sorted = [...depths].sort((a, b) => a - b);
    expect(depths).toEqual(sorted);
  });

  it("preserves distance from the pivot (the basis is orthonormal)", () => {
    const point = { x: 3, y: -4, z: 12 };
    const norm = Math.hypot(point.x, point.y, point.z);
    for (const camera of [
      ...Object.values(VIEW_PRESETS),
      { yaw: 17, pitch: -43 },
    ]) {
      const p = project(point, camera);
      close(Math.hypot(p.x, p.y, p.depth), norm, 1e-9);
    }
  });

  it("is linear, so a projected midpoint is the midpoint of the projections", () => {
    const camera: Camera3D = { yaw: 28, pitch: 19 };
    const a = { x: 1, y: 2, z: 3 };
    const b = { x: -7, y: 5, z: 11 };
    const mid = project(
      { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 },
      camera,
    );
    const pa = project(a, camera);
    const pb = project(b, camera);
    close(mid.x, (pa.x + pb.x) / 2);
    close(mid.y, (pa.y + pb.y) / 2);
  });
});

describe("projection3d camera normalization", () => {
  it("clamps pitch to straight up and straight down", () => {
    expect(clampPitch(140)).toBe(90);
    expect(clampPitch(-140)).toBe(-90);
    expect(clampPitch(31)).toBe(31);
  });

  it("wraps yaw into (−180, 180]", () => {
    expect(normalizeYaw(0)).toBe(0);
    expect(normalizeYaw(370)).toBe(10);
    expect(normalizeYaw(-370)).toBe(-10);
    expect(normalizeYaw(3600)).toBe(0);
    expect(normalizeYaw(-180)).toBe(180);
    expect(normalizeYaw(180)).toBe(180);
  });

  it("normalizeCamera applies both rules and identifies the front camera", () => {
    expect(normalizeCamera({ yaw: 720, pitch: 200 })).toEqual({
      yaw: 0,
      pitch: 90,
    });
    expect(isFrontCamera({ yaw: 720, pitch: 0 })).toBe(true);
    expect(isFrontCamera(VIEW_PRESETS.front)).toBe(true);
    expect(isFrontCamera(VIEW_PRESETS.iso)).toBe(false);
  });
});

describe("projection3d depth cues", () => {
  it("fades from near to far and clamps outside the unit range", () => {
    expect(depthOpacity(0)).toBe(NEAR_OPACITY);
    expect(depthOpacity(1)).toBe(FAR_OPACITY);
    expect(depthOpacity(-3)).toBe(NEAR_OPACITY);
    expect(depthOpacity(4)).toBe(FAR_OPACITY);
    expect(depthOpacity(0.5)).toBeGreaterThan(FAR_OPACITY);
    expect(depthOpacity(0.5)).toBeLessThan(NEAR_OPACITY);
  });

  it("stacks nearer elements above farther ones and stays positive", () => {
    expect(depthZIndex(0)).toBeGreaterThan(depthZIndex(1));
    expect(depthZIndex(1)).toBeGreaterThan(0);
    expect(Number.isInteger(depthZIndex(0.37))).toBe(true);
  });
});
