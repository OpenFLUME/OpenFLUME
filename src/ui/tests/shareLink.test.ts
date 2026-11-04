import { describe, expect, it } from "vitest";
import { examples } from "../examples";
import {
  buildExampleShareUrl,
  buildModelShareUrl,
  decodeModelPayload,
  encodeModelPayload,
  exampleNameFromSlug,
  exampleSlug,
  parseShareFragment,
} from "../shareLink";
import { parseModelFile, serializeModelFile } from "../utils";

describe("share links", () => {
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

  it("round-trips every example through an inline model link", async () => {
    for (const [name, config] of Object.entries(examples)) {
      const text = serializeModelFile(config);
      const payload = await encodeModelPayload(text);
      expect(payload, name).toMatch(/^[A-Za-z0-9_-]+$/);
      const decoded = await decodeModelPayload(payload);
      expect(decoded, name).toBe(text);
      expect(serializeModelFile(parseModelFile(decoded)), name).toBe(text);
    }
  });

  it("compresses: a link is much shorter than the raw model text", async () => {
    const text = serializeModelFile(examples["Tank blowdown"]);
    const payload = await encodeModelPayload(text);
    expect(payload.length).toBeLessThan(text.length);
  });

  it("parses fragments", async () => {
    expect(parseShareFragment("")).toEqual({ kind: "none" });
    expect(parseShareFragment("#example=tank-blowdown")).toEqual({
      kind: "example",
      slug: "tank-blowdown",
      name: "Tank blowdown",
    });
    expect(parseShareFragment("#example=nope")).toMatchObject({
      kind: "example",
      name: undefined,
    });
    const url = await buildModelShareUrl("https://x.test/app/", "hello");
    const hash = url.slice(url.indexOf("#"));
    const parsed = parseShareFragment(hash);
    expect(parsed.kind).toBe("model");
    if (parsed.kind === "model") {
      expect(await decodeModelPayload(parsed.payload)).toBe("hello");
    }
    expect(buildExampleShareUrl("https://x.test/", "Tank blowdown")).toBe(
      "https://x.test/#example=tank-blowdown",
    );
  });

  it("rejects a damaged payload instead of loading garbage", async () => {
    await expect(decodeModelPayload("not-a-real-payload")).rejects.toThrow();
  });
});
