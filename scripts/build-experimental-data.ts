/**
 * Generator for the experimental datasets behind the choked-flow,
 * cavitating-venturi, and tank self-pressurization validation reports.
 *
 *   npm run gen:experimental-data
 *
 * Reads the digitized CSVs listed in SOURCES below from
 *   validation/data/digitized/
 * and emits
 *   src/validation/generated/experimentalData.ts
 * as a committed TypeScript data module, following the design of
 * scripts/build-nbs-trace-corpus.ts (a plain TS module imports identically
 * in Node, tsx, vitest, Vite and the browser; the tests never read CSVs
 * except to recompute the source hash).
 *
 * The generator transcribes; it does not filter.  Every data row is kept
 * with its values as printed (numbers, or null for blank cells) and its
 * digitizer flags, and every `# ` header line is kept verbatim as the
 * provenance record.  Quality control (which rows are usable) lives in the
 * consuming modules (src/validation/chokedFlow.ts, cavitationHord.ts,
 * tankSelfPressurization.ts) where it is reviewable and tested.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SCRIPT_DIR, "..");
const DATA_DIR = path.join(ROOT, "validation", "data", "digitized");
const OUT_FILE = path.join(
  ROOT,
  "src",
  "validation",
  "generated",
  "experimentalData.ts",
);

const DATASET_VERSION = "openflume-experimental-data@1.0.0";

/** Exported constant name → CSV path relative to validation/data/digitized. */
const SOURCES: Record<string, string> = {
  SIMONEAU1975_N2_ORIFICE:
    "choked_flow_cavitation/simoneau1975_tmx71760_n2_orifice.csv",
  SIMONEAU1979_N2_7DEG_CONICAL:
    "choked_flow_cavitation/simoneau1979_tp1484_n2_7deg_conical.csv",
  SIMONEAU1979_N2_3P5DEG_CONICAL:
    "choked_flow_cavitation/simoneau1979_tp1484_n2_3p5deg_conical.csv",
  SIMONEAU1979_N2_ELLIPTICAL:
    "choked_flow_cavitation/simoneau1979_tp1484_n2_elliptical.csv",
  SIMONEAU1979_N2_2D: "choked_flow_cavitation/simoneau1979_tp1484_n2_2d.csv",
  SIMONEAU1979_CH4_ELLIPTICAL:
    "choked_flow_cavitation/simoneau1979_tp1484_ch4_elliptical.csv",
  SIMONEAU1979_H2_ELLIPTICAL:
    "choked_flow_cavitation/simoneau1979_tp1484_h2_elliptical.csv",
  HORD1972_LH2_VENTURI:
    "choked_flow_cavitation/hord1972_cr2054_lh2_venturi_SI.csv",
  HASAN1991_PRESSURE_RISE:
    "tank_pressurization/hasan1991_tm103804_pressure_rise_rates.csv",
};

function fail(msg: string): never {
  console.error(`build-experimental-data: ${msg}`);
  process.exit(1);
}

type Cell = number | string | null;

interface Parsed {
  header: string[];
  provenance: string[];
  rows: Cell[][];
}

function parseCsv(file: string): Parsed {
  const text = fs.readFileSync(path.join(DATA_DIR, file), "utf-8");
  const provenance: string[] = [];
  const body: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("#")) {
      provenance.push(raw.replace(/^#\s?/, ""));
      continue;
    }
    if (raw.trim() === "") continue;
    body.push(raw);
  }
  if (body.length < 2) fail(`${file}: no data rows`);
  const header = body[0].split(",").map((h) => h.trim());
  const rows = body.slice(1).map((line, k) => {
    // The CSVs contain no quoted fields; a quote would mean a format change.
    if (line.includes('"')) fail(`${file}: quoted field in row ${k + 1}`);
    const cells = line.split(",");
    if (cells.length !== header.length) {
      fail(
        `${file}: row ${k + 1} has ${cells.length} cells, header has ${header.length}`,
      );
    }
    return cells.map((c): Cell => {
      const t = c.trim();
      if (t === "") return null;
      const n = Number(t);
      return Number.isFinite(n) && /^[-+]?[\d.]+(e[-+]?\d+)?$/i.test(t) ? n : t;
    });
  });
  return { header, provenance, rows };
}

const parsed = Object.fromEntries(
  Object.entries(SOURCES).map(([name, file]) => [name, parseCsv(file)]),
);

const hash = crypto.createHash("sha256");
for (const file of Object.values(SOURCES).sort()) {
  hash.update(file);
  hash.update("\0");
  hash.update(fs.readFileSync(path.join(DATA_DIR, file)));
  hash.update("\0");
}
const sourceHash = hash.digest("hex");

const out: string[] = [];
out.push(`/**
 * ============================================================================
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source data : validation/data/digitized/** (files listed in
 *               EXPERIMENTAL_SOURCE_FILES)
 * Generator   : scripts/build-experimental-data.ts
 *               (npm run gen:experimental-data)
 *
 * Rows are transcribed as printed in the CSVs (null = blank cell); the
 * CSV header comments are kept verbatim in each table's provenance.  The
 * source hash is recomputed from disk by
 * src/validation/__tests__/experimentalData.test.ts.
 * ============================================================================
 */

export const EXPERIMENTAL_DATASET_VERSION = ${JSON.stringify(DATASET_VERSION)};
export const EXPERIMENTAL_SOURCE_HASH_SHA256 =
  ${JSON.stringify(sourceHash)};

export type Cell = number | string | null;

export interface ExperimentalTable {
  /** CSV path relative to validation/data/digitized. */
  file: string;
  /** The CSV's \`#\` header lines, verbatim. */
  provenance: readonly string[];
  columns: readonly string[];
  rows: readonly (readonly Cell[])[];
}

export const EXPERIMENTAL_SOURCE_FILES: readonly string[] = ${JSON.stringify(
  Object.values(SOURCES).sort(),
  null,
  2,
)};
`);

for (const [name, p] of Object.entries(parsed)) {
  out.push(`export const ${name}: ExperimentalTable = {
  file: ${JSON.stringify(SOURCES[name])},
  provenance: ${JSON.stringify(p.provenance, null, 2)},
  columns: ${JSON.stringify(p.header)},
  rows: [
${p.rows.map((r) => `    ${JSON.stringify(r)},`).join("\n")}
  ],
};
`);
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, out.join("\n"), "utf-8");
console.log(`wrote ${path.relative(ROOT, OUT_FILE)}`);
for (const [name, p] of Object.entries(parsed))
  console.log(`  ${name}: ${p.rows.length} rows`);
console.log(`  source sha256: ${sourceHash}`);
