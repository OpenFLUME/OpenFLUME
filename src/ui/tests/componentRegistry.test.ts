import { describe, expect, it } from "vitest";
import { defaultComponent } from "../componentRegistry";

describe("declarative component registry defaults", () => {
  it("provides usable defaults for dpTable, customResistance, and userComponent", () => {
    expect(defaultComponent("dpTable")).toEqual({
      type: "dpTable",
      points: [
        [0, 0],
        [1, 1000],
      ],
      extrapolate: "clamp",
    });
    expect(defaultComponent("customResistance")).toEqual({
      type: "customResistance",
      k: 1,
      area: 0.001,
    });
    expect(defaultComponent("userComponent")).toEqual({
      type: "userComponent",
      component: "",
      params: {},
      area: 0.001,
    });
  });
});
