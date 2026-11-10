/**
 * MRS validation data readers and the pre-registered metrics
 * (docs/validation/mrs-protocol.md).  Pure functions over CSV text so the
 * module has no file-system dependency: the CI gates and the report script
 * read validation/data/digitized/mrs/*.csv and pass the text in.
 */

/** Parse CSV text with double-quote quoting into rows of fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse CSV text into records keyed by the header row. */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const [head, ...body] = parseCsv(text);
  return body.map((r) => {
    const rec: Record<string, string> = {};
    head.forEach((h, i) => (rec[h] = r[i] ?? ""));
    return rec;
  });
}

const num = (s: string): number | undefined =>
  s.trim() === "" ? undefined : Number(s);

export type MrsSet = "primary" | "secondary" | "excluded";

export interface MrsRegistryEntry {
  testPoint: string;
  configuration: string;
  /** Series chains, panel numbers in flow order. */
  legs: number[][];
  set: MrsSet;
  setReason: string;
  sides: 1 | 2;
  tinF: number;
  totalFlowLbhr: number;
  /** Leg fractions used, one per leg. */
  fractions: number[];
  /** Absorbed flux per panel number [Btu/hr-ft2]. */
  flux: Record<number, number>;
  tmixMainTestF?: number;
  tmixMain1973F?: number;
}

export function readRegistry(text: string): MrsRegistryEntry[] {
  return parseCsvRecords(text).map((r) => {
    const flux: Record<number, number> = {};
    for (let i = 1; i <= 8; i++) {
      const v = num(r[`absorbed_panel${i}_Btuhr_ft2`]);
      if (v !== undefined) flux[i] = v;
    }
    return {
      testPoint: r.test_point,
      configuration: r.configuration,
      legs: r.legs
        ? r.legs.split(";").map((l) => l.split("-").map((x) => Number(x)))
        : [],
      set: r.set as MrsSet,
      setReason: r.set_reason,
      sides: Number(r.sides_radiating) === 2 ? 2 : 1,
      tinF: Number(r.Tin_main_F),
      totalFlowLbhr: Number(r.total_main_flow_lbhr),
      fractions: r.leg_fraction_used
        ? r.leg_fraction_used.split(";").map(Number)
        : [],
      flux,
      tmixMainTestF: num(r.Tmix_main_test_F),
      tmixMain1973F: num(r.Tmix_main_1973model_F),
    };
  });
}

export interface MrsPanelOutlet {
  testF?: number;
  model1973F?: number;
}

/** Panel main outlet temperatures from the maps: test point then panel. */
export function readPanelOutlets(
  text: string,
): Record<string, Record<number, MrsPanelOutlet>> {
  const out: Record<string, Record<number, MrsPanelOutlet>> = {};
  for (const r of parseCsvRecords(text)) {
    (out[r.test_point] ??= {})[Number(r.panel)] = {
      testF: num(r.Tout_panel_test_F),
      model1973F: num(r.Tout_panel_1973model_F),
    };
  }
  return out;
}

export interface MrsSystemOutlet {
  tmixMainTestF?: number;
  tmixMain1973F?: number;
}

export function readSystemOutlets(
  text: string,
): Record<string, MrsSystemOutlet> {
  const out: Record<string, MrsSystemOutlet> = {};
  for (const r of parseCsvRecords(text)) {
    out[r.test_point] = {
      tmixMainTestF: num(r.Tout_main_mixed_test_F),
      tmixMain1973F: num(r.Tout_main_mixed_1973model_F),
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Metrics                                                              */
/* ------------------------------------------------------------------ */

export interface ErrorStats {
  n: number;
  rms: number;
  maxAbs: number;
  bias: number;
}

export function errorStats(e: number[]): ErrorStats {
  const n = e.length;
  if (n === 0) return { n: 0, rms: NaN, maxAbs: NaN, bias: NaN };
  return {
    n,
    rms: Math.sqrt(e.reduce((s, x) => s + x * x, 0) / n),
    maxAbs: Math.max(...e.map(Math.abs)),
    bias: e.reduce((s, x) => s + x, 0) / n,
  };
}

/** Leg-end result of one test point: calculated panel outlet temperatures [F]. */
export type MrsPointResult = Record<number, number>;

export interface MrsPointMetrics {
  testPoint: string;
  panelErrors: Array<{
    panel: number;
    calc: number;
    test: number;
    model1973?: number;
  }>;
  /** Bank heat [Btu/hr] from leg end temperatures, calculated / test / 1973 model. */
  qBank: { calc?: number; test?: number; model1973?: number };
  /** Mixed main outlet [F] from leg end temperatures. */
  tmix: { calc?: number; test?: number; model1973?: number };
  /** Printed test and 1973 mixed main outlet from the map. */
  tmixPrinted: { test?: number; model1973?: number };
}

/**
 * Per-point metrics.  `h(T)` is one enthalpy function [J/kg] used for the
 * calculated, test and 1973-model temperatures alike, and `tInletF` is the
 * registry main inlet.
 */
export function pointMetrics(
  entry: MrsRegistryEntry,
  calc: MrsPointResult,
  outlets: Record<number, MrsPanelOutlet>,
  system: MrsSystemOutlet | undefined,
  h: (tF: number) => number,
  tInverse: (hJkg: number) => number,
): MrsPointMetrics {
  const panelErrors: MrsPointMetrics["panelErrors"] = [];
  for (const [p, t] of Object.entries(calc)) {
    const o = outlets[Number(p)];
    if (o?.testF !== undefined) {
      panelErrors.push({
        panel: Number(p),
        calc: t,
        test: o.testF,
        model1973: o.model1973F,
      });
    }
  }
  const total = entry.totalFlowLbhr;
  const hIn = h(entry.tinF);
  const qOf = (get: (panel: number) => number | undefined) => {
    let q = 0;
    let hm = 0;
    for (let i = 0; i < entry.legs.length; i++) {
      const t = get(entry.legs[i][entry.legs[i].length - 1]);
      if (t === undefined) return { q: undefined, t: undefined };
      const m = total * entry.fractions[i];
      // lb/hr * J/kg -> Btu/hr : 1 J/kg = 4.2992261e-4 Btu/lb
      q += m * (hIn - h(t)) * 4.2992261e-4;
      hm += entry.fractions[i] * h(t);
    }
    return { q, t: tInverse(hm) };
  };
  const c = qOf((p) => calc[p]);
  const t = qOf((p) => outlets[p]?.testF);
  const m = qOf((p) => outlets[p]?.model1973F);
  return {
    testPoint: entry.testPoint,
    panelErrors,
    qBank: { calc: c.q, test: t.q, model1973: m.q },
    tmix: { calc: c.t, test: t.t, model1973: m.t },
    tmixPrinted: {
      test: system?.tmixMainTestF,
      model1973: system?.tmixMain1973F,
    },
  };
}

export interface MrsSummary {
  panelOpenflume: ErrorStats;
  panel1973: ErrorStats;
  tmixPrintedOpenflume: ErrorStats;
  tmixPrinted1973: ErrorStats;
  tmixRecomputedOpenflume: ErrorStats;
  qBankOpenflumePct: ErrorStats;
  qBank1973Pct: ErrorStats;
  perPointQPct: Record<string, number>;
}

/** Aggregate per-point metrics over a set of test points. */
export function summarize(points: MrsPointMetrics[]): MrsSummary {
  const pe = points.flatMap((p) => p.panelErrors);
  const eO = pe.map((x) => x.calc - x.test);
  const e73 = pe
    .filter((x) => x.model1973 !== undefined)
    .map((x) => (x.model1973 as number) - x.test);
  const tpO: number[] = [];
  const tp73: number[] = [];
  const tpRe: number[] = [];
  const qO: number[] = [];
  const q73: number[] = [];
  const perPoint: Record<string, number> = {};
  for (const p of points) {
    const calcT = p.tmix.calc;
    if (calcT !== undefined && p.tmixPrinted.test !== undefined) {
      tpO.push(calcT - p.tmixPrinted.test);
      if (p.tmixPrinted.model1973 !== undefined)
        tp73.push(p.tmixPrinted.model1973 - p.tmixPrinted.test);
    }
    if (calcT !== undefined && p.tmix.test !== undefined)
      tpRe.push(calcT - p.tmix.test);
    if (p.qBank.calc !== undefined && p.qBank.test) {
      const e = 100 * (p.qBank.calc / p.qBank.test - 1);
      qO.push(e);
      perPoint[p.testPoint] = e;
      if (p.qBank.model1973 !== undefined)
        q73.push(100 * (p.qBank.model1973 / p.qBank.test - 1));
    }
  }
  return {
    panelOpenflume: errorStats(eO),
    panel1973: errorStats(e73),
    tmixPrintedOpenflume: errorStats(tpO),
    tmixPrinted1973: errorStats(tp73),
    tmixRecomputedOpenflume: errorStats(tpRe),
    qBankOpenflumePct: errorStats(qO),
    qBank1973Pct: errorStats(q73),
    perPointQPct: perPoint,
  };
}
