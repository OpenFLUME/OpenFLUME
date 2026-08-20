import { describe, expect, it } from "vitest";

describe("UI module import smoke", () => {
  it("imports the canvas without executing hooks at module scope", async () => {
    const canvas = await import("../components/FlowCanvas");
    expect(typeof canvas.default).toBe("function");
  });
});
