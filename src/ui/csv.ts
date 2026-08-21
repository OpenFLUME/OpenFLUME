const FORMULA_LEADER = /^[=+\-@\t\r]/;
const NUMERIC_TEXT = /^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?$/i;

/** RFC-4180 encoding with spreadsheet-formula protection for free text. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "";
  let text = value;
  if (!NUMERIC_TEXT.test(text.trim()) && FORMULA_LEADER.test(text))
    text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim()
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

export function csvRow(
  values: readonly (string | number | null | undefined)[],
): string {
  return values.map(csvCell).join(",");
}

export function csvCommentValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}
