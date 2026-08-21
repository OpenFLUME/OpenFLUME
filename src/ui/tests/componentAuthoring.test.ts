import { describe, expect, it } from "vitest";
import {
  generateComponentSource,
  suggestedComponentFileName,
  validateComponentDraft,
  type ComponentDraft,
} from "../componentAuthoring";

const draft: ComponentDraft = {
  name: "trim.k-factor",
  label: "Trim K-factor",
  description: "A deterministic test component.",
  version: "1.0.0",
  params: '[{"name":"K","default":2,"min":0}]',
  pressureDropBody: "return args.params.K * args.mdot * Math.abs(args.mdot);",
  heatBody: "",
};

describe("component authoring", () => {
  it("sanitizes names into component filenames", () => {
    expect(suggestedComponentFileName(" My Valve / Rev 2 ")).toBe(
      "my-valve-rev-2.component.js",
    );
    expect(suggestedComponentFileName("...")).toBe("component.component.js");
  });

  it("generates deterministic readable source that parses without running pressureDrop", () => {
    const first = generateComponentSource(draft);
    expect(generateComponentSource(draft)).toBe(first);
    expect(first).toContain("defineComponent({");
    expect(first).toContain("pressureDrop(args) {");
    expect(validateComponentDraft(draft)).toMatchObject({
      errors: {},
      source: first,
    });
  });

  it("validates keys, parameter JSON and bounds, and required pressure body", () => {
    expect(
      validateComponentDraft({
        ...draft,
        name: "bad key",
        pressureDropBody: "",
      }).errors,
    ).toMatchObject({
      name: expect.stringContaining("letters"),
      pressureDropBody: expect.stringContaining("required"),
    });
    expect(
      validateComponentDraft({
        ...draft,
        params: '[{"name":"K","default":3,"max":2}]',
      }).errors.params,
    ).toContain("within its bounds");
    expect(
      validateComponentDraft({
        ...draft,
        params: '[{"name":"K","default":null}]',
      }).errors.params,
    ).toContain("finite number");
  });

  it("reports generated function syntax errors without evaluating it", () => {
    const result = validateComponentDraft({
      ...draft,
      pressureDropBody: "return )",
    });
    expect(result.source).toBeUndefined();
    expect(result.errors.pressureDropBody).toBeTruthy();
    expect(
      validateComponentDraft({ ...draft, heatBody: "return (" }).errors
        .heatBody,
    ).toContain("Invalid function body");
  });
});
