import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_CANVAS_VISIBILITY,
  loadCanvasVisibility,
  saveCanvasVisibility,
  type CanvasVisibility,
} from "../utils";

describe("canvas visibility preference", () => {
  let store: Record<string, string> = {};
  beforeEach(() => {
    store = {};
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
        removeItem: (k: string) => {
          delete store[k];
        },
      },
      writable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined,
      writable: true,
    });
  });

  it("defaults to everything shown", () => {
    expect(loadCanvasVisibility()).toEqual(DEFAULT_CANVAS_VISIBILITY);
  });

  it("round-trips a partial hide through save/load", () => {
    const next: CanvasVisibility = {
      ...DEFAULT_CANVAS_VISIBILITY,
      thermalNodes: false,
      radiation: false,
    };
    saveCanvasVisibility(next);
    expect(loadCanvasVisibility()).toEqual(next);
  });

  it("merges an older persisted preference over the current defaults", () => {
    // Simulates a build that persisted before a new kind (e.g. radiation)
    // existed: the missing key must come back shown, not falsy/undefined.
    store["fluids-network-canvas-visibility-v1"] = JSON.stringify({
      fluidNodes: false,
    });
    const loaded = loadCanvasVisibility();
    expect(loaded.fluidNodes).toBe(false);
    expect(loaded.radiation).toBe(true);
    expect(loaded.thermalNodes).toBe(true);
  });

  it("falls back to defaults on malformed storage", () => {
    store["fluids-network-canvas-visibility-v1"] = "not json";
    expect(loadCanvasVisibility()).toEqual(DEFAULT_CANVAS_VISIBILITY);
  });

  it("falls back to defaults when storage is unavailable", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined,
      writable: true,
    });
    expect(loadCanvasVisibility()).toEqual(DEFAULT_CANVAS_VISIBILITY);
    expect(() => saveCanvasVisibility(DEFAULT_CANVAS_VISIBILITY)).not.toThrow();
  });
});
