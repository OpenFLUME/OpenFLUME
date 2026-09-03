import { describe, it, expect } from "vitest";
import {
  tokenizeFormula,
  segmentFormula,
  sourceFromSegments,
  removeSegmentSource,
  explodeSegmentSource,
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

describe("tokenizeFormula", () => {
  it("tokenizes numbers, strings, idents, ops, and punctuation with exact spans", () => {
    const src = `pipe('a').diameter * 1.5e-3 + node("n1").volume`;
    const tokens = tokenizeFormula(src);
    // Every token value is its exact source slice and tokens are ordered.
    let prevEnd = -1;
    for (const t of tokens) {
      expect(t.value).toBe(src.slice(t.start, t.end));
      expect(t.start).toBeGreaterThanOrEqual(prevEnd);
      prevEnd = t.end;
    }
    expect(tokens.map((t) => t.kind)).toEqual([
      "ident", // pipe
      "punct", // (
      "string", // 'a'
      "punct", // )
      "punct", // .
      "ident", // diameter
      "op", // *
      "number", // 1.5e-3
      "op", // +
      "ident", // node
      "punct", // (
      "string", // "n1"
      "punct", // )
      "punct", // .
      "ident", // volume
    ]);
  });

  it("handles numbers, multi-char operators, whitespace, and unknown chars", () => {
    const tokens = tokenizeFormula("  42 >= .5 && # ");
    expect(tokens).toEqual([
      { kind: "number", start: 2, end: 4, value: "42" },
      { kind: "op", start: 5, end: 7, value: ">=" },
      { kind: "number", start: 8, end: 10, value: ".5" },
      { kind: "op", start: 11, end: 13, value: "&&" },
      { kind: "unknown", start: 14, end: 15, value: "#" },
    ]);
  });

  it("never throws and stays tolerant on malformed input", () => {
    for (const src of [
      "",
      "(",
      ")",
      ",",
      ".",
      "'unterminated",
      '"',
      "\\",
      "1e",
      "1e+",
      "..",
      "pipe('x",
    ]) {
      expect(() => tokenizeFormula(src)).not.toThrow();
    }
    // Unterminated string becomes a string token running to end of source.
    expect(tokenizeFormula("a + 'x")).toEqual([
      { kind: "ident", start: 0, end: 1, value: "a" },
      { kind: "op", start: 2, end: 3, value: "+" },
      { kind: "string", start: 4, end: 6, value: "'x" },
    ]);
  });
});

describe("segmentFormula", () => {
  it("recognizes a standard reference chip with exact span", () => {
    const src = "pipe('inlet').diameter";
    const segments = segmentFormula(src);
    expect(segments).toEqual([
      {
        type: "chip",
        start: 0,
        end: src.length,
        chip: {
          accessor: "pipe",
          id: "inlet",
          idStart: 5,
          idEnd: 12,
          properties: ["diameter"],
          label: "inlet · diameter",
        },
      },
    ]);
  });

  it("recognizes every accessor and double-quoted ids", () => {
    for (const accessor of [
      "pipe",
      "heatedPipe",
      "bend",
      "branch",
      "node",
      "conductor",
      "solid",
    ] as const) {
      const src = `${accessor}("id-1").area`;
      const chips = chipsOf(segmentFormula(src));
      expect(chips).toHaveLength(1);
      expect(chips[0].chip.accessor).toBe(accessor);
      expect(chips[0].chip.id).toBe("id-1");
      expect(chips[0].chip.properties).toEqual(["area"]);
      expect(src.slice(chips[0].start, chips[0].end)).toBe(src);
    }
    // reg is a complete reference without a property chain.
    const reg = segmentFormula("reg('coolant flow')");
    expect(chipsOf(reg)).toHaveLength(1);
    expect(chipsOf(reg)[0].chip).toEqual({
      accessor: "reg",
      id: "coolant flow",
      idStart: 4,
      idEnd: 18,
      properties: [],
      label: "coolant flow",
    });
  });

  it("supports nested property chains like conductor correlation properties", () => {
    const src = "conductor('wall1').correlation.diameter";
    const segments = segmentFormula(src);
    expect(segments).toEqual([
      {
        type: "chip",
        start: 0,
        end: src.length,
        chip: {
          accessor: "conductor",
          id: "wall1",
          idStart: 10,
          idEnd: 17,
          properties: ["correlation", "diameter"],
          label: "wall1 · diameter",
        },
      },
    ]);
  });

  it("segments multiple chips mixed with operators and text", () => {
    const src = "0.5 * pipe('a').roughness / node('n1').volume + reg('k')";
    const segments = segmentFormula(src);
    const chips = chipsOf(segments);
    expect(chips).toHaveLength(3);
    expect(chips[0].chip).toMatchObject({
      accessor: "pipe",
      id: "a",
      properties: ["roughness"],
    });
    expect(chips[1].chip).toMatchObject({
      accessor: "node",
      id: "n1",
      properties: ["volume"],
    });
    expect(chips[2].chip).toMatchObject({
      accessor: "reg",
      id: "k",
      properties: [],
    });
    // Chip spans hold exactly the reference source text.
    expect(src.slice(chips[0].start, chips[0].end)).toBe("pipe('a').roughness");
    expect(src.slice(chips[1].start, chips[1].end)).toBe("node('n1').volume");
    expect(src.slice(chips[2].start, chips[2].end)).toBe("reg('k')");
    // Text segments carry the operators/operands between the chips.
    const texts = segments
      .filter((s) => s.type === "text")
      .map((s) => src.slice(s.start, s.end));
    expect(texts).toEqual(["0.5 * ", " / ", " + "]);
  });

  it("decodes escape sequences in chip ids without normalizing the source", () => {
    const src = String.raw`node('a\'b').volume`;
    const chips = chipsOf(segmentFormula(src));
    expect(chips).toHaveLength(1);
    expect(chips[0].chip.id).toBe("a'b");
    expect(src.slice(chips[0].start, chips[0].end)).toBe(src);
  });

  it("exposes the exact id-literal span (quotes included) on every chip", () => {
    // slice(idStart, idEnd) is the literal as written, so in-place rewrites
    // can preserve the original quote style (see usercode/rewriteIds.ts).
    const cases: Array<{ src: string; literal: string }> = [
      { src: "pipe('inlet').diameter", literal: "'inlet'" },
      { src: 'node("n1").volume', literal: '"n1"' },
      { src: String.raw`node('a\'b').volume`, literal: String.raw`'a\'b'` },
      { src: "  pipe( 'a' ) . diameter  ", literal: "'a'" },
      { src: "reg('coolant flow')", literal: "'coolant flow'" },
      {
        src: "conductor('w').correlation.diameter",
        literal: "'w'",
      },
    ];
    for (const { src, literal } of cases) {
      const chips = chipsOf(segmentFormula(src));
      expect(chips, src).toHaveLength(1);
      expect(src.slice(chips[0].chip.idStart, chips[0].chip.idEnd)).toBe(
        literal,
      );
      // The span always sits inside the chip's own span.
      expect(chips[0].chip.idStart).toBeGreaterThanOrEqual(chips[0].start);
      expect(chips[0].chip.idEnd).toBeLessThanOrEqual(chips[0].end);
    }
  });

  it("keeps malformed and incomplete references as plain text", () => {
    const cases = [
      "pipe(name).diameter", // non-literal id argument
      "pipe().diameter", // missing argument
      "pipe(12).diameter", // numeric argument
      "pipe('a').", // dangling property dot
      "pipe('a'", // unterminated string / missing close paren
      "pipe('a')", // bare call, no property
      "pipe 'a'.diameter", // missing parens
      "pipe('a','b').diameter", // extra argument
      "piper('a').diameter", // unknown accessor name
      "pipe(('a')).diameter", // parenthesized argument
      "pipe(", // lone partial call
    ];
    for (const src of cases) {
      let segments: FormulaSegment[] = [];
      expect(() => {
        segments = segmentFormula(src);
      }).not.toThrow();
      expect(chipsOf(segments), src).toHaveLength(0);
      expect(sourceFromSegments(src, segments)).toBe(src);
    }
    // Whole-source plain text when nothing segments.
    expect(segmentFormula("1 + 2 * x")).toEqual([
      { type: "text", start: 0, end: 9 },
    ]);
    expect(segmentFormula("")).toEqual([]);
  });

  it("rejects the incomplete reference but keeps the rest of the formula segmented", () => {
    const src = "pipe('x + node('n1').volume";
    const segments = segmentFormula(src);
    const chips = chipsOf(segments);
    // `pipe('x` is incomplete (string swallows ` + node('n1'` …); the
    // remaining `).volume` tail stays text too.  Nothing throws.
    expect(chips).toHaveLength(0);
    expect(sourceFromSegments(src, segments)).toBe(src);

    const src2 = "pipe('x') + node('n1').volume";
    const chips2 = chipsOf(segmentFormula(src2));
    // pipe('x') is not a complete reference (no property) but the node chip is.
    expect(chips2).toHaveLength(1);
    expect(chips2[0].chip.accessor).toBe("node");
  });

  it("reproduces the source exactly for arbitrary inputs (span preservation)", () => {
    const sources = [
      "",
      "   ",
      "1+1",
      "pipe('a').diameter",
      "  pipe( 'a' ) . diameter  ", // whitespace inside the reference
      "conductor('w').correlation.flowArea*2 - bend('b1').angle",
      "pipe('x", // garbage
      "### ???",
      "node('n').volume + 'stray string' + pipe(name).x",
      "solid('s1').temperature ^ 2 % reg('r')",
    ];
    for (const src of sources) {
      const segments = segmentFormula(src);
      expect(sourceFromSegments(src, segments)).toBe(src);
      // Segments are contiguous and cover [0, source.length].
      let cursor = 0;
      for (const seg of segments) {
        expect(seg.start).toBe(cursor);
        cursor = seg.end;
      }
      expect(cursor).toBe(src.length);
    }
    // Whitespace is tolerated inside the reference span and stays untouched.
    const ws = "  pipe( 'a' ) . diameter  ";
    expect(chipsOf(segmentFormula(ws))).toHaveLength(1);
  });
});

describe("removeSegmentSource", () => {
  it("removes a chip span and places the caret at the deletion point", () => {
    const src = "1 + pipe('a').diameter + 2";
    const chip = chipsOf(segmentFormula(src))[0];
    expect(src.slice(chip.start, chip.end)).toBe("pipe('a').diameter");
    const result = removeSegmentSource(src, chip);
    expect(result.source).toBe("1 +  + 2");
    expect(result.caret).toBe(4);
    expect(result.source.slice(result.caret)).toBe(" + 2");
  });

  it("removes a text span", () => {
    const src = "abc + def";
    const result = removeSegmentSource(src, { type: "text", start: 4, end: 5 });
    expect(result).toEqual({ source: "abc  def", caret: 4 });
  });
});

describe("explodeSegmentSource", () => {
  it("keeps the exact reference text and selects it for editing", () => {
    const src = "= 2*conductor('w').correlation.diameter";
    const chip = chipsOf(segmentFormula(src))[0];
    const result = explodeSegmentSource(src, chip);
    expect(result.source).toBe(src);
    expect(
      result.source.slice(result.selectionStart, result.selectionEnd),
    ).toBe("conductor('w').correlation.diameter");
  });

  it("passes text segments through with the span selected", () => {
    const src = "1 + x";
    const result = explodeSegmentSource(src, {
      type: "text",
      start: 0,
      end: 5,
    });
    expect(result).toEqual({ source: src, selectionStart: 0, selectionEnd: 5 });
  });
});

describe("sourceFromSegments", () => {
  it("round-trips the source through segmentation for every case above", () => {
    const sources = [
      "heatedPipe('hx').ua",
      "branch('b').area * conductor('c').k - reg('scale')",
      "pipe('unclosed",
      "pipe(name).diameter",
      "node('n1').volume>=1e-3 && solid('s').mass<10",
    ];
    for (const src of sources) {
      expect(sourceFromSegments(src, segmentFormula(src))).toBe(src);
    }
  });
});
