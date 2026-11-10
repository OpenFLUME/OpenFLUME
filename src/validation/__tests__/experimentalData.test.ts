/**
 * Provenance guard for src/validation/generated/experimentalData.ts: the
 * embedded SHA-256 must match the digitized CSVs on disk, and every table
 * must carry its source citation, mirroring the trace-corpus guard in
 * nbsTraceCorpus.test.ts.  Regenerate with `npm run gen:experimental-data`.
 */
import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as data from "../generated/experimentalData";

const DATA_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "validation",
  "data",
  "digitized",
);

const tables = Object.values(data).filter(
  (v): v is data.ExperimentalTable =>
    typeof v === "object" && v !== null && "rows" in v && "file" in v,
);

describe("experimental data module", () => {
  it("embedded SHA-256 matches the source CSVs on disk (no drift)", () => {
    const hash = crypto.createHash("sha256");
    for (const f of [...data.EXPERIMENTAL_SOURCE_FILES].sort()) {
      hash.update(f);
      hash.update("\0");
      hash.update(fs.readFileSync(path.join(DATA_DIR, f)));
      hash.update("\0");
    }
    expect(hash.digest("hex")).toBe(data.EXPERIMENTAL_SOURCE_HASH_SHA256);
  });

  it("every source file is transcribed, with its citation and full row count", () => {
    expect(tables.map((t) => t.file).sort()).toEqual(
      [...data.EXPERIMENTAL_SOURCE_FILES].sort(),
    );
    for (const t of tables) {
      expect(t.provenance.join("\n")).toMatch(/NASA|NBS|National Bureau/);
      const csvRows = fs
        .readFileSync(path.join(DATA_DIR, t.file), "utf-8")
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "" && !l.startsWith("#"));
      expect(t.rows.length).toBe(csvRows.length - 1);
      for (const r of t.rows) expect(r.length).toBe(t.columns.length);
    }
  });
});
