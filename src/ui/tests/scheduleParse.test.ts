import { describe, it, expect } from "vitest";
import {
  parseDelimited,
  parseScheduleText,
  cellsToSchedule,
  firstMonotonicViolation,
  hasDuplicateX,
} from "../scheduleParse";

describe("scheduleParse", () => {
  it("parseDelimited handles TSV, CSV, and mixed line endings", () => {
    expect(parseDelimited("0\t100\n1\t90")).toEqual([
      ["0", "100"],
      ["1", "90"],
    ]);
    expect(parseDelimited("0,100\r\n1,90\r")).toEqual([
      ["0", "100"],
      ["1", "90"],
    ]);
    expect(parseDelimited("0, 100\n\n1, 90\n")).toEqual([
      ["0", "100"],
      ["1", "90"],
    ]);
    // A tab anywhere on the line wins over commas (Excel paste style)
    expect(parseDelimited("a\tb,c")).toEqual([["a", "b,c"]]);
  });

  it("cellsToSchedule converts display units to SI", () => {
    // Pasted in kPa → stored in Pa
    const { rows, skipped } = cellsToSchedule(
      [
        ["0", "150"],
        ["2", "101.325"],
      ],
      "time",
      "pressure",
      "s",
      "kPa",
    );
    expect(skipped).toBe(0);
    expect(rows[0][1]).toBeCloseTo(150000);
    expect(rows[1][1]).toBeCloseTo(101325);
    // °C → K (offset unit)
    const t = cellsToSchedule([["0", "20"]], "time", "temperature", "s", "C");
    expect(t.rows[0][1]).toBeCloseTo(293.15);
  });

  it("skips header lines and malformed rows, counting them", () => {
    const { rows, skipped } = parseScheduleText(
      "Time\tPressure\n0\t100\nabc\t50\n1\n2\t90\n",
      "time",
      "pressure",
      "s",
      "Pa",
    );
    expect(rows).toEqual([
      [0, 100],
      [2, 90],
    ]);
    expect(skipped).toBe(3);
  });

  it("firstMonotonicViolation finds the first out-of-order row", () => {
    expect(
      firstMonotonicViolation([
        [0, 1],
        [1, 2],
        [3, 4],
      ]),
    ).toBeNull();
    expect(
      firstMonotonicViolation([
        [0, 1],
        [3, 2],
        [2, 4],
      ]),
    ).toBe(2);
    expect(
      firstMonotonicViolation([
        [0, 1],
        [0, 5],
      ]),
    ).toBeNull(); // equal x is allowed here
  });

  it("hasDuplicateX detects repeated x values", () => {
    expect(
      hasDuplicateX([
        [0, 1],
        [1, 2],
      ]),
    ).toBe(false);
    expect(
      hasDuplicateX([
        [0, 1],
        [0, 2],
      ]),
    ).toBe(true);
  });
});
