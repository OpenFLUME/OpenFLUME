import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  zoomTier,
  counterScale,
  showsNodeName,
  showsNodeChip,
  ZOOM_TIER_FULL,
  DENSE_ELEMENT_COUNT,
  type ZoomTier,
} from "../zoomTiers";
import { loadShowLabels, saveShowLabels } from "../utils";

const ALL_TIERS: ZoomTier[] = ["full", "names", "sparse", "hidden"];

/** Default: nothing pointed at, nothing culled, labels on. */
function name(overrides: Partial<Parameters<typeof showsNodeName>[0]>) {
  return showsNodeName({
    tier: "full",
    showLabels: true,
    selected: false,
    hovered: false,
    pinned: false,
    culled: false,
    ...overrides,
  });
}

describe("zoomTier", () => {
  it("steps down through the density ladder as zoom falls", () => {
    expect(zoomTier(1.5)).toBe("full");
    expect(zoomTier(ZOOM_TIER_FULL)).toBe("full");
    expect(zoomTier(0.6)).toBe("names");
    expect(zoomTier(0.35)).toBe("sparse");
    expect(zoomTier(0.1)).toBe("hidden");
  });

  it("escalates the names threshold for dense graphs", () => {
    // 0.5 still shows names on a small model but is already too crowded once
    // the model passes DENSE_ELEMENT_COUNT elements.
    expect(zoomTier(0.5, false)).toBe("names");
    expect(zoomTier(0.5, true)).toBe("sparse");
    expect(DENSE_ELEMENT_COUNT).toBe(50);
  });
});

describe("counterScale", () => {
  it("inverts zoom so labels hold a constant screen size", () => {
    expect(counterScale(2)).toBe("scale(0.5)");
    expect(counterScale(0.5)).toBe("scale(2)");
  });
});

describe("showsNodeName", () => {
  it("draws every name at full detail", () => {
    expect(name({ tier: "full" })).toBe(true);
    // Full detail aggregates rather than culls, so a cull verdict cannot
    // reach it — but if one did, the name still wins.
    expect(name({ tier: "full", culled: true })).toBe(true);
  });

  it("honours the declutter verdict at the crowded names tier", () => {
    expect(name({ tier: "names", culled: false })).toBe(true);
    expect(name({ tier: "names", culled: true })).toBe(false);
    // Selection outranks culling: the user must always see what they picked.
    expect(name({ tier: "names", culled: true, selected: true })).toBe(true);
  });

  it("keeps only pointed-at and pinned names when zoomed out to sparse", () => {
    expect(name({ tier: "sparse" })).toBe(false);
    expect(name({ tier: "sparse", hovered: true })).toBe(true);
    expect(name({ tier: "sparse", selected: true })).toBe(true);
    // Boundaries/ambients carry the drawing's inputs, so they hold on longer.
    expect(name({ tier: "sparse", pinned: true })).toBe(true);
  });

  it("keeps only the selection at the hidden tier", () => {
    expect(name({ tier: "hidden", hovered: true, pinned: true })).toBe(false);
    expect(name({ tier: "hidden", selected: true })).toBe(true);
  });

  it("labels off beats every reason a name would otherwise show", () => {
    // The toggle is absolute — this is what separates it from the zoom tiers,
    // which always keep the selected element named.
    for (const tier of ALL_TIERS) {
      expect(
        showsNodeName({
          tier,
          showLabels: false,
          selected: true,
          hovered: true,
          pinned: true,
          culled: false,
        }),
      ).toBe(false);
    }
  });
});

describe("showsNodeChip", () => {
  it("draws readouts at full detail only", () => {
    expect(
      showsNodeChip({ tier: "full", showLabels: true, hasContent: true }),
    ).toBe(true);
    for (const tier of ALL_TIERS.filter((t) => t !== "full")) {
      expect(showsNodeChip({ tier, showLabels: true, hasContent: true })).toBe(
        false,
      );
    }
  });

  it("draws nothing when the node has no result or boundary condition", () => {
    expect(
      showsNodeChip({ tier: "full", showLabels: true, hasContent: false }),
    ).toBe(false);
  });

  it("labels off hides readouts too, not just names", () => {
    // Turning names off while leaving pressures/temperatures/flows on the
    // drawing would still bury the schematic in text.
    expect(
      showsNodeChip({ tier: "full", showLabels: false, hasContent: true }),
    ).toBe(false);
  });
});

describe("show-labels preference", () => {
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

  it("defaults to shown and round-trips both settings", () => {
    expect(loadShowLabels()).toBe(true);
    saveShowLabels(false);
    expect(loadShowLabels()).toBe(false);
    saveShowLabels(true);
    expect(loadShowLabels()).toBe(true);
  });

  it("falls back to shown when storage is unavailable", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined,
      writable: true,
    });
    expect(loadShowLabels()).toBe(true);
    expect(() => saveShowLabels(false)).not.toThrow();
  });
});
