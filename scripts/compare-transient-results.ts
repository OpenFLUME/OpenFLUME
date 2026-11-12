/**
 * compare-transient-results.ts — element-wise comparison of two saved
 * TransientResult JSON files (e.g. written by transient-perf-harness.ts
 * --out before and after a solver change).
 *
 *   npx tsx scripts/compare-transient-results.ts <a.json> <b.json> [--steps N]
 *
 * Compares every numeric history (node P/T/ρ/h/…, branch ṁ, solid T,
 * conductor Q/h, per-step residual and iteration series) over the common
 * prefix of steps (or the first N steps), and reports per-group max |Δ|,
 * max relative Δ and the number of bit-identical entries.
 */
import { readFileSync } from "node:fs";

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) {
  console.error(
    "usage: compare-transient-results.ts a.json b.json [--steps N]",
  );
  process.exit(2);
}
const si = process.argv.indexOf("--steps");
const stepLimit = si >= 0 ? Number(process.argv[si + 1]) : Infinity;
const A = JSON.parse(readFileSync(fa, "utf8")) as Record<string, unknown>;
const B = JSON.parse(readFileSync(fb, "utf8")) as Record<string, unknown>;
const nTimes = Math.min(
  (A.times as number[]).length,
  (B.times as number[]).length,
  Number.isFinite(stepLimit) ? stepLimit + 1 : Infinity,
);

interface Stat {
  n: number;
  identical: number;
  maxAbs: number;
  maxRel: number;
  where: string;
}
const groups = new Map<string, Stat>();
const stat = (g: string): Stat => {
  let s = groups.get(g);
  if (!s) {
    s = { n: 0, identical: 0, maxAbs: 0, maxRel: 0, where: "" };
    groups.set(g, s);
  }
  return s;
};

function walk(a: unknown, b: unknown, path: string[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length > 0 && typeof a[0] === "number") {
      // Time-indexed series (times has one more entry than step series; both
      // are truncated to the common prefix).
      const n = Math.min(a.length, b.length, nTimes);
      const g = path.filter((p) => !p.startsWith("#")).join(".");
      const s = stat(g);
      for (let i = 0; i < n; i++) {
        const x = a[i] as number;
        const y = b[i] as number;
        s.n++;
        if (Object.is(x, y)) {
          s.identical++;
          continue;
        }
        const d = Math.abs(x - y);
        const r = d / Math.max(Math.abs(x), Math.abs(y), 1e-300);
        if (d > s.maxAbs) s.maxAbs = d;
        if (r > s.maxRel) {
          s.maxRel = r;
          s.where = `${path.join(".")}[${i}] ${x} vs ${y}`;
        }
      }
      return;
    }
    const n = Math.min(a.length, b.length, nTimes);
    for (let i = 0; i < n; i++) walk(a[i], b[i], path);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of Object.keys(a as object)) {
      if (!(k in (b as object))) continue;
      // Entity ids collapse into one group per quantity.
      const isId =
        path.length > 0 &&
        ["nodes", "branches", "solidNodes", "conductors", "junctions"].includes(
          path[path.length - 1],
        );
      walk(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        [...path, isId ? `#${k}` : k],
      );
    }
  }
}
walk(A, B, []);

console.log(
  `common time points: ${nTimes} (t = 0 … ${(A.times as number[])[nTimes - 1]})`,
);
console.log(
  "group".padEnd(40),
  "entries".padStart(8),
  "identical".padStart(10),
  "max|Δ|".padStart(12),
  "max relΔ".padStart(12),
);
let worst = 0;
for (const [g, s] of [...groups].sort()) {
  console.log(
    g.padEnd(40),
    String(s.n).padStart(8),
    String(s.identical).padStart(10),
    s.maxAbs.toExponential(3).padStart(12),
    s.maxRel.toExponential(3).padStart(12),
    s.maxRel > 0 ? `  @ ${s.where}` : "",
  );
  worst = Math.max(worst, s.maxRel);
}
console.log(`overall max relative difference: ${worst.toExponential(3)}`);
