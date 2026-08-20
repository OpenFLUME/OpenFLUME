/**
 * Placement math for the "Build a formula" popover (ui/formulaBrowserLayout).
 *
 * The regression that motivated this: opened from an f(x) button low in the
 * property panel, the panel kept its full height and ran off the bottom of the
 * window, so its lower half was unreachable.  Placement now caps the height to
 * the room available, and the header drag keeps the panel on screen.
 */
import { describe, it, expect } from "vitest";
import {
  anchoredPlacement,
  clampBrowserPosition,
  draggedPlacement,
  formulaBrowserWidth,
  type AnchorRect,
} from "../formulaBrowserLayout";

const viewport = { width: 1280, height: 900 };

/** f(x) button rect with its bottom edge `bottom` px from the viewport top. */
function anchor(bottom: number, height = 22, right = 1240): AnchorRect {
  return { top: bottom - height, bottom, right };
}

describe("formulaBrowserWidth", () => {
  it("caps at 420 px and shrinks to fit a narrow viewport", () => {
    expect(formulaBrowserWidth(viewport)).toBe(420);
    expect(formulaBrowserWidth({ width: 360, height: 900 })).toBe(344);
  });
});

describe("anchoredPlacement", () => {
  it("opens below the anchor, right-aligned to it", () => {
    const placement = anchoredPlacement(anchor(120), viewport);
    expect(placement.top).toBe(126);
    expect(placement.bottom).toBeUndefined();
    expect(placement.left).toBe(1240 - 420);
  });

  it("flips above the anchor when the room below is unusable", () => {
    const placement = anchoredPlacement(anchor(820), viewport);
    expect(placement.top).toBeUndefined();
    // Grows upward from the anchor top (798), i.e. 900 - 798 + 6 from the bottom.
    expect(placement.bottom).toBe(108);
  });

  it("never extends past the bottom of the viewport when it opens below", () => {
    for (const bottom of [120, 400, 560, 600]) {
      const placement = anchoredPlacement(anchor(bottom), viewport);
      if (placement.top === undefined) continue;
      expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(
        viewport.height,
      );
    }
  });

  it("never extends past the top of the viewport when it flips above", () => {
    const placement = anchoredPlacement(anchor(880, 22, 400), viewport);
    expect(placement.bottom).toBeDefined();
    expect(placement.maxHeight).toBeLessThanOrEqual(
      viewport.height - placement.bottom!,
    );
  });

  it("keeps a usable height on a viewport too short for any placement", () => {
    const short = { width: 1280, height: 240 };
    const placement = anchoredPlacement(anchor(200), short);
    expect(placement.maxHeight).toBe(200);
  });

  it("keeps the panel on screen when the anchor sits at the left edge", () => {
    const placement = anchoredPlacement(anchor(120, 22, 40), viewport);
    expect(placement.left).toBe(8);
  });
});

describe("clampBrowserPosition", () => {
  it("passes through a position that is already on screen", () => {
    expect(clampBrowserPosition({ left: 300, top: 200 }, viewport)).toEqual({
      left: 300,
      top: 200,
    });
  });

  it("clamps a drag past the right and bottom edges", () => {
    expect(clampBrowserPosition({ left: 5000, top: 5000 }, viewport)).toEqual({
      left: 1280 - 420 - 8,
      top: 900 - 200 - 8,
    });
  });

  it("clamps a drag past the top and left edges", () => {
    expect(clampBrowserPosition({ left: -400, top: -400 }, viewport)).toEqual({
      left: 8,
      top: 8,
    });
  });
});

describe("draggedPlacement", () => {
  it("ignores the anchor and uses the dragged corner", () => {
    const placement = draggedPlacement({ left: 120, top: 60 }, viewport);
    expect(placement).toEqual({
      left: 120,
      top: 60,
      width: 420,
      maxHeight: 520,
    });
  });

  it("shrinks the panel dragged low so it still fits on screen", () => {
    const placement = draggedPlacement({ left: 120, top: 500 }, viewport);
    expect(placement.top).toBe(500);
    expect(placement.maxHeight).toBe(392);
    expect(placement.top! + placement.maxHeight).toBeLessThanOrEqual(
      viewport.height,
    );
  });
});
