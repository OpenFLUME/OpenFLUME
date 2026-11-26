/**
 * embedMode.test.ts — read-only embed mode (issue #26):
 * `?embed=1` parses, other values do not, full-editor URLs strip only
 * the embed parameter and keep the fragment.
 */
import { describe, it, expect } from "vitest";
import {
  parseEmbedMode,
  buildFullEditorUrl,
  EMBED_QUERY_KEY,
} from "../embedMode";

describe("parseEmbedMode", () => {
  it("is true for ?embed=1", () => {
    expect(parseEmbedMode("?embed=1")).toBe(true);
    expect(parseEmbedMode("embed=1")).toBe(true);
  });

  it("is false otherwise", () => {
    expect(parseEmbedMode("")).toBe(false);
    expect(parseEmbedMode("?embed=0")).toBe(false);
    expect(parseEmbedMode("?foo=bar")).toBe(false);
  });
});

describe("buildFullEditorUrl", () => {
  it("removes only the embed parameter and keeps the fragment", () => {
    const url = buildFullEditorUrl(
      "https://example.com/?embed=1&foo=bar#example=tank-blowdown",
    );
    expect(url).toBe("https://example.com/?foo=bar#example=tank-blowdown");
  });

  it("leaves no query string when embed was the only parameter", () => {
    const url = buildFullEditorUrl("https://example.com/?embed=1");
    expect(url).toBe("https://example.com/");
  });

  it("never drops other parameters", () => {
    expect(new URL(buildFullEditorUrl("https://x/?a=1&embed=1&b=2")).search)
      .toBe("?a=1&b=2");
    expect(EMBED_QUERY_KEY).toBe("embed");
  });
});
