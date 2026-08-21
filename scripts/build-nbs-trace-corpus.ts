/**
 * Generator for the versioned NBS-9264 wall-temperature trace corpus.
 *
 *   npm run gen:trace-corpus
 *
 * Reads the 11 digitized figure CSVs + run-metadata CSV from
 *   validation/data/digitized/chilldown/
 * (tracked in git; produced by the external digitization effort) and emits
 *   src/validation/generated/nbsTraceCorpusData.ts
 * as a COMMITTED TypeScript data module.
 *
 * Why a generated TS module instead of runtime loading:
 *   - Static `node:fs` reads break the browser/Vite build (the simulator is
 *     a fully client-side app), and dynamic runtime fetches of data files
 *     are banned by the pre-registered protocol (reproducibility: the
 *     dataset must be versioned WITH the code that consumes it).
 *   - Vite `?raw` imports would work in vite/vitest but NOT in plain
 *     Node/tsx — and the calibration tooling (scripts/*.ts) runs under
 *     tsx. A plain TS data module is the only format that imports
 *     identically in Node, tsx, vitest, vite build, and the browser.
 *   - Committing the generated module makes the exact calibration input
 *     reviewable in diffs and pins it to a source-content hash
 *     (re-computed by the corpus tests, so drift between CSVs and the
 *     generated module fails the test suite).
 *
 * This script runs in Node ONLY (dev tooling); it is never imported by
 * src/. It fails loudly on any integrity violation — the generated
 * module is only written when every check passes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = path.join(
  SCRIPT_DIR,
  "..",
  "validation",
  "data",
  "digitized",
  "chilldown",
);
const OUT_FILE = path.join(
  SCRIPT_DIR,
  "..",
  "src",
  "validation",
  "generated",
  "nbsTraceCorpusData.ts",
);

/** Corpus schema/semver version — bump when the curated structure changes. */
const DATASET_VERSION = "nbs9264-trace-corpus@1.1.0";

/**
 * The EXACT set of figure CSVs admitted to the trace corpus (allowlist).
 * Any other CSV in the directory — e.g.
 * brennan1966_nbs9264_inlet_restriction_results.csv, a scalar inlet-
 * restriction table whose header carries the KNOWN-WRONG station list
 * "~20, 60, 100, 140 ft" (audit finding; correct: 20/80/141/198 ft) —
 * must never silently enter the trace corpus.  The runtime validator in
 * src/validation/nbsTraceCorpus.ts repeats this guard.
 */
const FIGURE_FILES = [
  "nbs9264_fig02_lh2_5p1atm.csv",
  "nbs9264_fig03_lh2_2p5atm.csv",
  "nbs9264_fig04_lh2_4p2atm.csv",
  "nbs9264_fig05_lh2_5p9atm.csv",
  "nbs9264_fig06_lh2_7p6atm.csv",
  "nbs9264_fig07_lh2_11p0atm.csv",
  "nbs9264_fig10_ln2_2p5atm.csv",
  "nbs9264_fig11_ln2_3p4atm.csv",
  "nbs9264_fig12_ln2_5p9atm.csv",
  "nbs9264_fig13_ln2_4p2atm.csv",
  "nbs9264_fig14_ln2_5p9atm.csv",
] as const;

const METADATA_FILE = "nbs9264_runs_metadata.csv";

/**
 * Rounded station positions (m) as printed in the CSVs
 * (report-rounded values of the exact 20/80/141/198 ft geometry).
 */
const CANONICAL_STATION_SOURCE_M = [6.1, 24.4, 43.0, 60.4];

function fail(msg: string): never {
  throw new Error(`build-nbs-trace-corpus: ${msg}`);
}

interface StationSamples {
  sourceM: number;
  timesS: number[];
  wallTempsK: number[];
}

interface FigureCsv {
  file: string;
  figure: string;
  pdfPage: number;
  fluid: "LH2" | "LN2";
  liquidState: "saturated" | "subcooled";
  pDriveAtm: number;
  pDrivePa: number;
  resampleDtS: number;
  uncTempK: number; // upper bound of the marker-localization band
  uncTimeS: number;
  figureFlagsText: string;
  markersPerStation: [number, number, number, number];
  stations: StationSamples[]; // 4, in station order 1..4
}

function parseFigureCsv(file: string): FigureCsv {
  const text = fs.readFileSync(path.join(DATA_DIR, file), "utf-8");
  const lines = text.split("\n");
  const comments = lines.filter((l) => l.startsWith("#"));
  const get = (prefix: string): string => {
    const line = comments.find((l) => l.startsWith(prefix));
    if (!line) fail(`${file}: missing header line "${prefix}"`);
    return line;
  };

  const srcM = get("# SOURCE:").match(/Fig\. (\d+), PDF page (\d+)/);
  if (!srcM) fail(`${file}: cannot parse SOURCE line`);
  const figure = srcM[1];
  const pdfPage = Number(srcM[2]);

  const rcM = get("# RUN CONDITIONS:").match(
    /fluid=(LH2|LN2); state=(saturated|subcooled); P_drive=([\d.]+) atm \((\d+) Pa\)/,
  );
  if (!rcM) fail(`${file}: cannot parse RUN CONDITIONS line`);
  const fluid = rcM[1] as "LH2" | "LN2";
  const liquidState = rcM[2] as "saturated" | "subcooled";
  const pDriveAtm = Number(rcM[3]);
  const pDrivePa = Number(rcM[4]);

  const dmM = get("# DIGITIZATION METHOD:").match(
    /uniform resample dt=([\d.]+) s/,
  );
  if (!dmM) fail(`${file}: cannot parse resample dt from DIGITIZATION METHOD`);
  const resampleDtS = Number(dmM[1]);

  const unLine = get("# UNCERTAINTY:");
  const unM = unLine.match(/\+\/-([\d.]+)-([\d.]+) K, \+\/-([\d.]+) s/);
  if (!unM) fail(`${file}: cannot parse UNCERTAINTY line`);
  // Carry the CONSERVATIVE (upper) end of the marker-localization band.
  const uncTempK = Number(unM[2]);
  const uncTimeS = Number(unM[3]);
  const flagsSplit = unLine.split("Figure flags:");
  const figureFlagsText = flagsSplit.length > 1 ? flagsSplit[1].trim() : "";

  const mkM = get("# MARKERS DIGITIZED").match(
    /\{1: (\d+), 2: (\d+), 3: (\d+), 4: (\d+)\}/,
  );
  if (!mkM) fail(`${file}: cannot parse MARKERS DIGITIZED line`);
  const markersPerStation: [number, number, number, number] = [
    Number(mkM[1]),
    Number(mkM[2]),
    Number(mkM[3]),
    Number(mkM[4]),
  ];

  // ---- data rows ----
  const byStation = new Map<number, StationSamples>();
  let sawColumnHeader = false;
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("time_s,")) {
      sawColumnHeader = true;
      continue;
    }
    const parts = line.split(",");
    if (parts.length !== 3) fail(`${file}: malformed data row: "${line}"`);
    const t = Number(parts[0]);
    const s = Number(parts[1]);
    const T = Number(parts[2]);
    if (!Number.isFinite(t) || !Number.isFinite(s) || !Number.isFinite(T)) {
      fail(`${file}: non-finite data row: "${line}"`);
    }
    // Map the rounded CSV station position onto the canonical set.
    const canonical = CANONICAL_STATION_SOURCE_M.find(
      (c) => Math.abs(c - s) < 0.05,
    );
    if (canonical === undefined) {
      fail(
        `${file}: station_m=${s} is not one of the canonical rounded NBS ` +
          `positions ${CANONICAL_STATION_SOURCE_M.join("/")} m ` +
          `(20/80/141/198 ft).  REFUSING to import — check for the known-bad ` +
          `"~20/60/100/140 ft" station list.`,
      );
    }
    let st = byStation.get(canonical);
    if (!st) {
      st = { sourceM: canonical, timesS: [], wallTempsK: [] };
      byStation.set(canonical, st);
    }
    st.timesS.push(t);
    st.wallTempsK.push(T);
  }
  if (!sawColumnHeader)
    fail(`${file}: missing "time_s,station_m,T_wall_K" column header`);

  const stations = CANONICAL_STATION_SOURCE_M.map((m) => {
    const st = byStation.get(m);
    if (!st) fail(`${file}: no rows for station at ${m} m`);
    return st;
  });

  // ---- integrity ----
  for (const st of stations) {
    const n = st.timesS.length;
    if (n < 4) fail(`${file}: station ${st.sourceM} m has only ${n} samples`);
    for (let i = 1; i < n; i++) {
      if (!(st.timesS[i] > st.timesS[i - 1])) {
        fail(
          `${file}: station ${st.sourceM} m times not strictly ascending at index ${i}`,
        );
      }
    }
    for (let i = 0; i < n; i++) {
      const T = st.wallTempsK[i];
      // Loose sanity band only — NOT a physical-validity assertion.  The
      // NBS report itself flags low-T TC inaccuracies; per-trace QC flags
      // live in src/validation/nbsTraceCorpus.ts.
      if (!(T > 1 && T < 400))
        fail(
          `${file}: station ${st.sourceM} m T=${T} K outside [1,400] sanity band`,
        );
      const t = st.timesS[i];
      if (!(t >= 0 && t <= 1000))
        fail(
          `${file}: station ${st.sourceM} m t=${t} s outside [0,1000] sanity band`,
        );
    }
  }
  // NOTE: marker counts are carried as provenance only.  Since the
  // 2026-08-13 clicker-gold promotion they are the hand-clicked marker
  // counts (sparse visual markers, always < sample count); no ordering
  // against the sample count is enforced.
  markersPerStation.forEach((mk, i) => {
    if (!(mk >= 0)) fail(`${file}: station ${i + 1} negative marker count`);
  });

  return {
    file,
    figure,
    pdfPage,
    fluid,
    liquidState,
    pDriveAtm,
    pDrivePa,
    resampleDtS,
    uncTempK,
    uncTimeS,
    figureFlagsText,
    markersPerStation,
    stations,
  };
}

interface MetadataRow {
  figure: string;
  fluid: string;
  liquidState: string;
  pDriveAtm: number;
  pDrivePa: number;
  tInletK: number;
  timeSpanS: number;
  pdfPage: number;
}

function parseMetadata(): Map<string, MetadataRow> {
  const text = fs.readFileSync(path.join(DATA_DIR, METADATA_FILE), "utf-8");
  const rows = new Map<string, MetadataRow>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("figure,")) continue;
    const c = line.split(",");
    if (c.length !== 12) fail(`${METADATA_FILE}: malformed row: "${line}"`);
    rows.set(c[0], {
      figure: c[0],
      fluid: c[1],
      liquidState: c[2],
      pDriveAtm: Number(c[3]),
      pDrivePa: Number(c[4]),
      tInletK: Number(c[5]),
      timeSpanS: Number(c[10]),
      pdfPage: Number(c[11]),
    });
  }
  return rows;
}

function main(): void {
  const metadata = parseMetadata();
  const figures = FIGURE_FILES.map(parseFigureCsv);

  // Cross-check each figure CSV against the run-metadata CSV.
  for (const fig of figures) {
    const meta = metadata.get(fig.figure);
    if (!meta) fail(`fig ${fig.figure}: no row in ${METADATA_FILE}`);
    if (meta.fluid !== fig.fluid)
      fail(`fig ${fig.figure}: fluid mismatch vs metadata`);
    if (meta.liquidState !== fig.liquidState)
      fail(`fig ${fig.figure}: liquid_state mismatch vs metadata`);
    if (Math.abs(meta.pDriveAtm - fig.pDriveAtm) > 1e-9)
      fail(`fig ${fig.figure}: P_drive_atm mismatch vs metadata`);
    if (Math.abs(meta.pDrivePa - fig.pDrivePa) > 2)
      fail(`fig ${fig.figure}: P_drive_Pa mismatch vs metadata`);
    if (meta.pdfPage !== fig.pdfPage)
      fail(`fig ${fig.figure}: pdf_page mismatch vs metadata`);
    const maxT = Math.max(
      ...fig.stations.map((s) => s.timesS[s.timesS.length - 1]),
    );
    if (Math.abs(meta.timeSpanS - maxT) > 0.01) {
      fail(
        `fig ${fig.figure}: metadata time_span_s=${meta.timeSpanS} vs data max ${maxT}`,
      );
    }
  }

  // Source-content hash over the exact inputs (sorted) — the corpus tests
  // recompute this from disk so CSV/generated drift fails the suite.
  const hash = crypto.createHash("sha256");
  const sourceFiles = [...FIGURE_FILES, METADATA_FILE].sort();
  for (const f of sourceFiles) {
    hash.update(f);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(DATA_DIR, f)));
    hash.update("\0");
  }
  const sourceHash = hash.digest("hex");

  const totalSamples = figures.reduce(
    (acc, f) => acc + f.stations.reduce((a, s) => a + s.timesS.length, 0),
    0,
  );

  // ---- emit ----
  const out: string[] = [];
  out.push("/**");
  out.push(
    " * ============================================================================",
  );
  out.push(" * GENERATED FILE — DO NOT EDIT BY HAND.");
  out.push(" *");
  out.push(
    " * Source data : validation/data/digitized/chilldown/nbs9264_fig*.csv (+11 runs)",
  );
  out.push(
    " *               validation/data/digitized/chilldown/nbs9264_runs_metadata.csv",
  );
  out.push(
    " * Generator   : scripts/build-nbs-trace-corpus.ts   (npm run gen:trace-corpus)",
  );
  out.push(" *");
  out.push(
    " * The generated-TypeScript-module design (vs runtime fs / vite ?raw) is",
  );
  out.push(" * documented in the generator header:");
  out.push(
    " * it imports identically in Node, tsx, vitest, vite build and the browser,",
  );
  out.push(
    " * and pins the calibration input to the source-content hash below",
  );
  out.push(
    " * (recomputed from disk by src/validation/__tests__/nbsTraceCorpus.test.ts).",
  );
  out.push(
    " * ============================================================================",
  );
  out.push(" */");
  out.push("");
  out.push(
    `export const NBS9264_TRACE_DATASET_VERSION = '${DATASET_VERSION}';`,
  );
  out.push(`export const NBS9264_SOURCE_HASH_SHA256 =`);
  out.push(`  '${sourceHash}';`);
  out.push(`export const NBS9264_TOTAL_SAMPLES = ${totalSamples};`);
  out.push("export const NBS9264_SOURCE_FILES: readonly string[] = [");
  for (const f of sourceFiles) out.push(`  '${f}',`);
  out.push("];");
  out.push("");
  out.push(
    "/** One station trace of one run, as parsed from the figure CSV. */",
  );
  out.push("export interface RawTraceStationData {");
  out.push(
    "  /** Rounded station position (m) exactly as printed in the CSV (6.1/24.4/43.0/60.4). */",
  );
  out.push("  sourceM: number;");
  out.push("  timesS: number[];");
  out.push("  wallTempsK: number[];");
  out.push("}");
  out.push("");
  out.push(
    "/** One physical experimental run (one NBS-9264 figure) = 4 station traces. */",
  );
  out.push("export interface RawTraceRunData {");
  out.push("  runId: string; // 'nbs9264-figNN'");
  out.push("  figure: string;");
  out.push("  pdfPage: number;");
  out.push("  sourceFile: string;");
  out.push("  fluid: 'LH2' | 'LN2';");
  out.push("  liquidState: 'saturated' | 'subcooled';");
  out.push("  pDriveAtm: number;");
  out.push("  pDrivePa: number;");
  out.push(
    "  /** Inlet liquid temperature (K) from the run-metadata CSV (Tsat(P_drive) for saturated runs). */",
  );
  out.push("  tInletK: number;");
  out.push(
    "  /** Max time_s in the figure (s), cross-checked against the metadata CSV. */",
  );
  out.push("  timeSpanS: number;");
  out.push("  /** Uniform resample step used by the digitizer (s). */");
  out.push("  resampleDtS: number;");
  out.push(
    "  /** Digitizer uncertainty: upper bound of marker-localization band. */",
  );
  out.push("  uncTempK: number;");
  out.push("  uncTimeS: number;");
  out.push(
    '  /** Verbatim "Figure flags:" text from the CSV header (digitizer QC notes). */',
  );
  out.push("  figureFlagsText: string;");
  out.push(
    "  /** Original-marker counts per station (CSV rows are a uniform resample of the marker chain). */",
  );
  out.push("  markersPerStation: [number, number, number, number];");
  out.push(
    "  stations: [RawTraceStationData, RawTraceStationData, RawTraceStationData, RawTraceStationData];",
  );
  out.push("}");
  out.push("");
  out.push("export const NBS9264_TRACE_RUN_DATA: RawTraceRunData[] = [");

  const fmtArray = (vals: number[], indent: string): string[] => {
    const lines: string[] = [];
    let cur = indent;
    for (const v of vals) {
      const s = String(v) + ",";
      if (cur.length + s.length + 1 > 110) {
        lines.push(cur);
        cur = indent + s;
      } else {
        cur += (cur === indent ? "" : "") + s;
      }
    }
    if (cur.trim().length > 0) lines.push(cur);
    return lines;
  };

  for (const fig of figures) {
    const meta = metadata.get(fig.figure)!;
    out.push("  {");
    out.push(`    runId: 'nbs9264-fig${fig.figure.padStart(2, "0")}',`);
    out.push(`    figure: 'Fig. ${fig.figure}',`);
    out.push(`    pdfPage: ${fig.pdfPage},`);
    out.push(`    sourceFile: '${fig.file}',`);
    out.push(`    fluid: '${fig.fluid}',`);
    out.push(`    liquidState: '${fig.liquidState}',`);
    out.push(`    pDriveAtm: ${fig.pDriveAtm},`);
    out.push(`    pDrivePa: ${fig.pDrivePa},`);
    out.push(`    tInletK: ${meta.tInletK},`);
    out.push(`    timeSpanS: ${meta.timeSpanS},`);
    out.push(`    resampleDtS: ${fig.resampleDtS},`);
    out.push(`    uncTempK: ${fig.uncTempK},`);
    out.push(`    uncTimeS: ${fig.uncTimeS},`);
    out.push(`    figureFlagsText: ${JSON.stringify(fig.figureFlagsText)},`);
    out.push(`    markersPerStation: [${fig.markersPerStation.join(", ")}],`);
    out.push("    stations: [");
    for (const st of fig.stations) {
      out.push("      {");
      out.push(`        sourceM: ${st.sourceM},`);
      out.push("        timesS: [");
      out.push(...fmtArray(st.timesS, "          "));
      out.push("        ],");
      out.push("        wallTempsK: [");
      out.push(...fmtArray(st.wallTempsK, "          "));
      out.push("        ],");
      out.push("      },");
    }
    out.push("    ],");
    out.push("  },");
  }
  out.push("];");
  out.push("");

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, out.join("\n"), "utf-8");

  console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)}`);
  console.log(`  dataset version : ${DATASET_VERSION}`);
  console.log(`  source sha256   : ${sourceHash}`);
  console.log(`  runs            : ${figures.length}`);
  console.log(`  total samples   : ${totalSamples}`);
  for (const fig of figures) {
    const per = fig.stations.map((s) => s.timesS.length).join("/");
    console.log(
      `  fig${fig.figure.padStart(2, "0")} ${fig.fluid} ${fig.liquidState.padEnd(9)} ` +
        `P=${String(fig.pDriveAtm).padEnd(4)} atm  samples/stn ${per}  markers ${fig.markersPerStation.join("/")}`,
    );
  }
}

main();
