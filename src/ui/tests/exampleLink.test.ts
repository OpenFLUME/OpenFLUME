import { describe, expect, it } from "vitest";
import { examples } from "../examples";
import {
  buildExampleUrl,
  exampleNameFromSlug,
  exampleSlug,
  parseExampleFragment,
} from "../exampleLink";

describe("example deep links", () => {
  it("gives every shipped example a unique, URL-safe slug", () => {
    const names = Object.keys(examples);
    const slugs = names.map(exampleSlug);
    expect(new Set(slugs).size).toBe(names.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const name of names) {
      expect(exampleNameFromSlug(exampleSlug(name))).toBe(name);
    }
  });

  it("keeps the documented slugs stable", () => {
    // These appear in published docs, posts, and worksheets. Renaming an
    // example must not silently break them.
    expect(exampleSlug("Tank blowdown")).toBe("tank-blowdown");
    expect(exampleSlug("Sanity: orifice hand-calc")).toBe(
      "sanity-orifice-hand-calc",
    );
    expect(exampleSlug("Cryogenic line cooldown")).toBe(
      "cryogenic-line-cooldown",
    );
    expect(exampleSlug("LOX/RP-1 thruster (combustor)")).toBe(
      "lox-rp-1-thruster-combustor",
    );
  });

  it("parses fragments", () => {
    expect(parseExampleFragment("")).toEqual({ kind: "none" });
    expect(parseExampleFragment("#model=abc")).toEqual({ kind: "none" });
    expect(parseExampleFragment("#example=tank-blowdown")).toEqual({
      kind: "example",
      slug: "tank-blowdown",
      name: "Tank blowdown",
    });
    expect(parseExampleFragment("#example=nope")).toMatchObject({
      kind: "example",
      name: undefined,
    });
    expect(buildExampleUrl("https://x.test/", "Tank blowdown")).toBe(
      "https://x.test/#example=tank-blowdown",
    );
  });
});
