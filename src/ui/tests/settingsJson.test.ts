import { describe, expect, it } from "vitest";
import { parseAdvancedConfigJson } from "../settingsJson";

describe("advanced settings JSON", () => {
  it("parses the expected section containers", () => {
    expect(parseAdvancedConfigJson("registers", '{"count": 1}')).toEqual({
      value: { count: 1 },
    });
    expect(
      parseAdvancedConfigJson("logic", '[{"id":"tick","when":"t > 1"}]'),
    ).toEqual({
      value: [{ id: "tick", when: "t > 1" }],
    });
    expect(parseAdvancedConfigJson("controllers", "[]")).toEqual({ value: [] });
  });

  it("returns local errors for invalid JSON and shapes", () => {
    expect(parseAdvancedConfigJson("logic", "{")).toHaveProperty("error");
    expect(parseAdvancedConfigJson("registers", '{"count":"one"}')).toEqual({
      error: "Register values must be finite numbers.",
    });
    expect(parseAdvancedConfigJson("controllers", "{}")).toEqual({
      error: "Controllers must be a JSON array.",
    });
  });
});
