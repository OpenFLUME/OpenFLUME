import { describe, it, expect } from "vitest";
import { layoutLabels, LabelItem } from "../labelLayout";

const edge = (
  id: string,
  x: number,
  y: number,
  text = id,
  alwaysShow = false,
): LabelItem => ({
  id,
  x,
  y,
  text,
  kind: "edge",
  alwaysShow,
});

describe("labelLayout", () => {
  it("keeps well-separated labels visible", () => {
    const items = [edge("a", 0, 0), edge("b", 300, 0), edge("c", 0, 300)];
    const { hidden } = layoutLabels(items);
    expect(hidden.size).toBe(0);
  });

  it("culls overlapping labels in deterministic reading order", () => {
    // Two chips at nearly the same spot: the first (top-most/left-most) wins.
    const items = [edge("later", 52, 10), edge("first", 50, 0)];
    const { hidden } = layoutLabels(items);
    expect(hidden.has("later")).toBe(true);
    expect(hidden.has("first")).toBe(false);
  });

  it("selected (alwaysShow) labels are never culled and claim space first", () => {
    const items = [
      edge("normal", 50, 0),
      edge("selected", 52, 2, "selected", true),
    ];
    const { hidden } = layoutLabels(items);
    expect(hidden.has("selected")).toBe(false);
    expect(hidden.has("normal")).toBe(true);
  });

  it("aggregates identical labels into Name ×N when enabled", () => {
    const items = [
      edge("c1", 0, 0, "Wall conv"),
      edge("c2", 200, 0, "Wall conv"),
      edge("c3", 400, 0, "Wall conv"),
    ];
    const { hidden, text } = layoutLabels(items, { aggregate: true });
    expect(hidden.has("c2")).toBe(true);
    expect(hidden.has("c3")).toBe(true);
    expect(text.get("c1")).toBe("Wall conv ×3");
  });

  it("does not aggregate distinct labels or when disabled", () => {
    const items = [
      edge("c1", 0, 0, "Hot conv 1"),
      edge("c2", 200, 0, "Hot conv 2"),
    ];
    const { hidden, text } = layoutLabels(items, { aggregate: true });
    expect(hidden.size).toBe(0);
    expect(text.size).toBe(0);
    const noAgg = layoutLabels([
      edge("c1", 0, 0, "X"),
      edge("c2", 200, 0, "X"),
    ]);
    expect(noAgg.text.size).toBe(0);
    expect(noAgg.hidden.size).toBe(0);
  });

  it("a dense band of repeated labels collapses to non-overlapping survivors", () => {
    // Simulates the GFSSP Ex.5 conductor band at zoom 0.5: 12 chips 35px apart.
    const items = Array.from({ length: 12 }, (_, i) =>
      edge(`hw${i + 1}`, i * 35, 100, `Hot conv ${i + 1}`),
    );
    const { hidden } = layoutLabels(items);
    expect(hidden.size).toBeGreaterThan(0);
    // Verify survivors don't overlap: recompute rects for survivors.
    // (16 = EDGE_PAD_W: chip padding; edge chips no longer carry an icon.)
    const survivors = items.filter((it) => !hidden.has(it.id));
    for (let i = 0; i < survivors.length; i++) {
      for (let j = i + 1; j < survivors.length; j++) {
        const a = survivors[i];
        const b = survivors[j];
        const aw = (a.text.length * 6.4 + 16) / 2;
        const bw = (b.text.length * 6.4 + 16) / 2;
        expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(aw + bw - 0.001);
      }
    }
  });
});
