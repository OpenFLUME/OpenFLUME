/**
 * Examples-library text round trip.
 *
 * Every entry of the ui/examples library must round-trip through
 * serializeText -> parseText with ZERO errors and exact
 * (strict) deep equality — no skips, no normalization.
 *
 * This lives in the UI layer (not src/substrate/__tests__) because it
 * exercises the UI-owned example library: substrate tests must depend only
 * on core. Substrate's own suite uses a representative fixture subset (see
 * src/substrate/__tests__/fixtures.ts).
 */

import { describe, it, expect } from "vitest";
import { examples } from "../examples";
import {
  parseText,
  serializeTextWithLineMap,
} from "../../substrate/textProjection";

describe("examples library text round-trip", () => {
  it("covers exactly 12 examples", () => {
    expect(Object.keys(examples)).toHaveLength(12);
  });

  const failures: string[] = [];
  for (const [name, example] of Object.entries(examples)) {
    it(`round-trips exactly: ${name}`, () => {
      try {
        const { text } = serializeTextWithLineMap(example);
        const result = parseText(text);
        expect(result.errors).toEqual([]);
        expect(result.config).toStrictEqual(example);
      } catch (e) {
        failures.push(name);
        throw e;
      }
    });
  }

  it("has zero named failures", () => {
    expect(failures).toEqual([]);
  });
});
