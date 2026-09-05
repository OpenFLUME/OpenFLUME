/**
 * rewriteIds.ts — entity-id rewriting inside user formula expressions:
 * exact-span in-place replacement, formatting/quote-style preservation,
 * register exclusion, escaping, malformed-input tolerance, and
 * segmentation round-trip invariants after rewriting.
 */
import { describe, it, expect } from "vitest";
import { rewriteExpressionIds } from "../usercode/rewriteIds";
import {
  segmentFormula,
  sourceFromSegments,
  type FormulaSegment,
} from "../usercode/formulaTokens";

/** Collect the chip segments of a segmentation result. */
function chipsOf(
  segments: FormulaSegment[],
): Extract<FormulaSegment, { type: "chip" }>[] {
  return segments.filter(
    (s): s is Extract<FormulaSegment, { type: "chip" }> => s.type === "chip",
  );
}

describe("rewriteExpressionIds", () => {
  it("rewrites a single reference id in place", () => {
    expect(
      rewriteExpressionIds("pipe('seg1').length", new Map([["seg1", "seg2"]])),
    ).toBe("pipe('seg2').length");
  });

  it("rewrites multiple references across different accessors in one expression", () => {
    const src = "pipe('seg1').length + node('n1').volume * bend('b1').angle";
    const out = rewriteExpressionIds(
      src,
      new Map([
        ["seg1", "seg2"],
        ["n1", "n2"],
        ["b1", "b2"],
      ]),
    );
    expect(out).toBe(
      "pipe('seg2').length + node('n2').volume * bend('b2').angle",
    );
  });

  it("preserves arithmetic, operators, and irregular whitespace byte-for-byte", () => {
    const src = "pipe('seg1').length  *   2 +\t node('n1').volume";
    const out = rewriteExpressionIds(
      src,
      new Map([
        ["seg1", "seg2"],
        ["n1", "n2"],
      ]),
    );
    expect(out).toBe("pipe('seg2').length  *   2 +\t node('n2').volume");
  });

  it("replaces only the id literal, keeping whitespace inside the reference untouched", () => {
    const src = "  pipe( 'seg1' ) . length * 2";
    const out = rewriteExpressionIds(src, new Map([["seg1", "seg2"]]));
    expect(out).toBe("  pipe( 'seg2' ) . length * 2");
  });

  it("applies the plain-id map to every entity accessor, even on cross-accessor id collisions", () => {
    // Documented semantics: the map is keyed by PLAIN id (not accessor+id).
    // Fluid/solid node ids share a namespace and branch ids another, but a
    // pipe literally named 'n1' collides with the node 'n1' here — both are
    // remapped.  Callers build a disjoint map per authoring operation, so
    // such collisions cannot arise in practice.
    const src = "pipe('n1').length + node('n1').volume";
    const out = rewriteExpressionIds(src, new Map([["n1", "n2"]]));
    expect(out).toBe("pipe('n2').length + node('n2').volume");
  });

  it("never rewrites reg() references — registers are not entities", () => {
    const src = "reg('x') + pipe('x').length";
    const out = rewriteExpressionIds(src, new Map([["x", "y"]]));
    expect(out).toBe("reg('x') + pipe('y').length");
    // A lone register reference stays untouched even when its name is mapped.
    expect(rewriteExpressionIds("reg('k')", new Map([["k", "v"]]))).toBe(
      "reg('k')",
    );
  });

  it("escapes replacement ids containing a single quote", () => {
    const src = "pipe('a').length";
    const out = rewriteExpressionIds(src, new Map([["a", "it's"]]));
    expect(out).toBe(String.raw`pipe('it\'s').length`);
    // …and the result still segments with the decoded id.
    expect(chipsOf(segmentFormula(out))[0].chip.id).toBe("it's");
  });

  it("escapes replacement ids containing a backslash", () => {
    const src = "pipe('a').length";
    const out = rewriteExpressionIds(src, new Map([["a", "c\\d"]]));
    expect(out).toBe(String.raw`pipe('c\\d').length`);
    expect(chipsOf(segmentFormula(out))[0].chip.id).toBe("c\\d");
  });

  it("handles replacement ids containing spaces and both quote kinds", () => {
    expect(
      rewriteExpressionIds("pipe('a b').length", new Map([["a b", "c d"]])),
    ).toBe("pipe('c d').length");
    // A double quote needs no escaping inside a single-quoted literal.
    const out = rewriteExpressionIds(
      "pipe('a').length",
      new Map([["a", 'say "hi"']]),
    );
    expect(out).toBe("pipe('say \"hi\"').length");
    // Both quotes at once: the active quote is escaped, the other stays literal.
    const both = rewriteExpressionIds(
      "pipe('a').length",
      new Map([["a", `q'"w`]]),
    );
    expect(both).toBe(String.raw`pipe('q\'"w').length`);
  });

  it("matches ids by their DECODED value (escapes in the source resolved)", () => {
    const src = String.raw`pipe('we\'ird').length + pipe('x\\y').roughness`;
    const out = rewriteExpressionIds(
      src,
      new Map([
        ["we'ird", "plain"],
        ["x\\y", "z"],
      ]),
    );
    expect(out).toBe("pipe('plain').length + pipe('z').roughness");
  });

  it("round-trips double-quoted references, preserving the quote style", () => {
    expect(
      rewriteExpressionIds('pipe("seg1").length', new Map([["seg1", "seg2"]])),
    ).toBe('pipe("seg2").length');
    // A single quote inside a double-quoted literal needs no escaping.
    const out = rewriteExpressionIds(
      'pipe("a").length',
      new Map([["a", "it's"]]),
    );
    expect(out).toBe('pipe("it\'s").length');
  });

  it("never throws on malformed or partial input and leaves it unchanged", () => {
    const map = new Map([
      ["seg1", "seg2"],
      ["a", "b"],
    ]);
    const cases = [
      "pipe('seg1'", // unterminated / missing close paren
      "pipe(", // lone partial call
      "pipe('seg1').", // dangling property dot
      "pipe('seg1')", // bare call, no property — not a complete reference
      "", // empty
      "   ", // whitespace only
      "1 +* 2", // operator garbage
      "pipe('a' + 'b')", // non-literal argument shape
    ];
    for (const src of cases) {
      let out = "";
      expect(() => {
        out = rewriteExpressionIds(src, map);
      }).not.toThrow();
      expect(out, src).toBe(src);
    }
  });

  it("returns the source unchanged for an empty map", () => {
    const src = "pipe('seg1').length + reg('k')";
    expect(rewriteExpressionIds(src, new Map())).toBe(src);
  });

  it("returns the source unchanged when no chip id matches the map", () => {
    const src = "pipe('seg1').length + node('n1').volume";
    expect(rewriteExpressionIds(src, new Map([["other", "x"]]))).toBe(src);
  });

  it("preserves chained properties on nested references", () => {
    expect(
      rewriteExpressionIds(
        "conductor('c1').correlation.diameter",
        new Map([["c1", "c2"]]),
      ),
    ).toBe("conductor('c2').correlation.diameter");
  });

  it("never touches property names that collide with mapped ids", () => {
    const map = new Map([
      ["length", "x"],
      ["diameter", "y"],
      ["correlation", "z"],
    ]);
    expect(rewriteExpressionIds("pipe('seg1').length", map)).toBe(
      "pipe('seg1').length",
    );
    expect(
      rewriteExpressionIds("conductor('c1').correlation.diameter", map),
    ).toBe("conductor('c1').correlation.diameter");
    // …while an id that happens to equal a property name IS rewritten.
    const renamed = rewriteExpressionIds(
      "pipe('seg1').length",
      new Map([["seg1", "length"]]),
    );
    expect(renamed).toBe("pipe('length').length");
    expect(chipsOf(segmentFormula(renamed))[0].chip.id).toBe("length");
  });

  it("restores the original source when a map is followed by its inverse", () => {
    const src = "pipe('seg1').length * node('n1').volume + reg('scale')";
    const forward = new Map([
      ["seg1", "seg2"],
      ["n1", "n2"],
    ]);
    const inverse = new Map([
      ["seg2", "seg1"],
      ["n2", "n1"],
    ]);
    const rewritten = rewriteExpressionIds(src, forward);
    expect(rewritten).toBe(
      "pipe('seg2').length * node('n2').volume + reg('scale')",
    );
    expect(rewriteExpressionIds(rewritten, inverse)).toBe(src);
  });

  it("keeps segmentation round-trip invariants after rewriting", () => {
    const cases: Array<{ src: string; map: Map<string, string> }> = [
      {
        src: "heatedPipe('hx').ua",
        map: new Map([["hx", "hx-2"]]),
      },
      {
        src: "  pipe( 'a' ) . diameter  * conductor('w').correlation.flowArea",
        map: new Map([
          ["a", "b"],
          ["w", "w2"],
        ]),
      },
      {
        src: String.raw`node('a\'b').volume >= 1e-3 && solid('s').mass < 10`,
        map: new Map([
          ["a'b", "c"],
          ["s", "s2"],
        ]),
      },
      {
        src: "branch('b').area - reg('k') + bend('b').angle",
        map: new Map([["b", "b2"]]),
      },
    ];
    for (const { src, map } of cases) {
      const out = rewriteExpressionIds(src, map);
      // The rewritten source still reproduces itself through segmentation.
      expect(sourceFromSegments(out, segmentFormula(out)), src).toBe(out);
      const before = chipsOf(segmentFormula(src));
      const after = chipsOf(segmentFormula(out));
      // Same chips in the same order, property chains untouched…
      expect(after, src).toHaveLength(before.length);
      for (let i = 0; i < before.length; i++) {
        expect(after[i].chip.accessor).toBe(before[i].chip.accessor);
        expect(after[i].chip.properties).toEqual(before[i].chip.properties);
        const expectedId =
          before[i].chip.accessor === "reg"
            ? before[i].chip.id
            : (map.get(before[i].chip.id) ?? before[i].chip.id);
        expect(after[i].chip.id).toBe(expectedId);
      }
      // …and every non-chip character survives verbatim: stripping chip
      // spans from both sources must yield the same text skeleton.
      const skeleton = (s: string, segs: FormulaSegment[]): string =>
        segs
          .filter((seg) => seg.type === "text")
          .map((seg) => s.slice(seg.start, seg.end))
          .join("");
      expect(skeleton(out, segmentFormula(out))).toBe(
        skeleton(src, segmentFormula(src)),
      );
    }
  });
});
