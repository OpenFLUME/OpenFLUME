import { describe, expect, it } from "vitest";
import { csvCell, csvCommentValue, csvRow } from "../csv";

describe("CSV serialization", () => {
  it("quotes separators, quotes, line breaks, and surrounding whitespace", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell(" padded ")).toBe('" padded "');
  });

  it("guards spreadsheet formulas without converting numeric text", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-1.25e-3")).toBe("-1.25e-3");
    expect(csvCell(-1.25e-3)).toBe("-0.00125");
  });

  it("builds rows and strips line breaks from provenance comments", () => {
    expect(csvRow(["name", "a,b", 2])).toBe('name,"a,b",2');
    expect(csvCommentValue("one\r\ntwo")).toBe("one two");
  });
});
