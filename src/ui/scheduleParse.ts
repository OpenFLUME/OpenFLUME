/**
 * scheduleParse.ts — clipboard → schedule rows.
 *
 * Analysts copy two-column data out of Excel/Sheets (tab-separated) or a CSV
 * file (comma-separated) and paste it straight into a schedule/curve grid.
 * Pasted numbers are interpreted in the grid's CURRENT DISPLAY units and
 * converted to SI here via units.ts, so a paste matches what the analyst sees.
 */
import { QuantityKind, UnitId, convertToSI } from "./units";

/** Split clipboard text into a cell matrix. Tabs win over commas per line. */
export function parseDelimited(text: string): string[][] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      (line.includes("\t") ? line.split("\t") : line.split(",")).map((c) =>
        c.trim(),
      ),
    );
}

/**
 * Strict full-string numeric parse: "10 ft" or "1.5e3Pa" is rejected rather
 * than silently truncated the way parseFloat would truncate it.
 */
function parseStrictNumber(cell: string): number {
  const trimmed = cell.trim();
  return trimmed === "" ? NaN : Number(trimmed);
}

export interface ScheduleParseResult {
  /** Parsed rows in SI. */
  rows: Array<[number, number]>;
  /** Lines skipped because either cell was empty/non-numeric. */
  skipped: number;
}

/**
 * Convert a parsed cell matrix to SI schedule rows. Extra columns beyond the
 * first two are ignored; lines that look like a header (non-numeric first
 * cell) are skipped and counted.
 */
export function cellsToSchedule(
  cells: string[][],
  xKind: QuantityKind,
  yKind: QuantityKind,
  xUnit: UnitId,
  yUnit: UnitId,
): ScheduleParseResult {
  const rows: Array<[number, number]> = [];
  let skipped = 0;
  for (const line of cells) {
    if (line.length < 2) {
      skipped++;
      continue;
    }
    const x = parseStrictNumber(line[0]);
    const y = parseStrictNumber(line[1]);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      skipped++;
      continue;
    }
    rows.push([convertToSI(xKind, x, xUnit), convertToSI(yKind, y, yUnit)]);
  }
  return { rows, skipped };
}

/** One-call convenience: clipboard text → SI schedule rows. */
export function parseScheduleText(
  text: string,
  xKind: QuantityKind,
  yKind: QuantityKind,
  xUnit: UnitId,
  yUnit: UnitId,
): ScheduleParseResult {
  return cellsToSchedule(parseDelimited(text), xKind, yKind, xUnit, yUnit);
}

/** Non-decreasing-x check (schedules must be time-monotonic for the solver). */
export function firstMonotonicViolation(
  rows: Array<[number, number]>,
): number | null {
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i + 1][0] < rows[i][0]) return i + 1;
  }
  return null;
}

/** True when any two rows share an identical x value. */
export function hasDuplicateX(rows: Array<[number, number]>): boolean {
  const seen = new Set<number>();
  for (const [x] of rows) {
    if (seen.has(x)) return true;
    seen.add(x);
  }
  return false;
}
