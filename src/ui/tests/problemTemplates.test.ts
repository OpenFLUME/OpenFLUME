/**
 * Problem templates must always produce valid, runnable starting points:
 * every template builds from a bundled example, validates clean, and gets
 * renamed to the template label so the user's file isn't called by the
 * example's benchmark name.
 */
import { describe, it, expect } from "vitest";
import { PROBLEM_TEMPLATES, buildTemplateConfig } from "../problemTemplates";
import { examples } from "../examples";
import { validateNetwork } from "../../core";

describe("problem templates", () => {
  it("has unique ids and labels", () => {
    const ids = PROBLEM_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const labels = PROBLEM_TEMPLATES.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each(PROBLEM_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s builds a valid config",
    (_id, template) => {
      expect(examples[template.exampleName]).toBeDefined();
      const cfg = buildTemplateConfig(template);
      expect(cfg.meta.name).toBe(template.label);
      expect(validateNetwork(cfg)).toEqual([]);
      // A template must never share object identity with the example.
      expect(cfg).not.toBe(examples[template.exampleName]);
      expect(cfg.nodes).not.toBe(examples[template.exampleName].nodes);
    },
  );

  it("every template describes its seeds", () => {
    for (const t of PROBLEM_TEMPLATES) {
      expect(t.seeds.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(10);
    }
  });
});
