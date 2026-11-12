/**
 * transient-perf-harness.ts — per-step timing + attribution for a transient
 * NetworkConfig solve (the same decode → validate → init → solve path as the
 * Python bridge, python/bridge/server.ts).
 *
 *   npx tsx scripts/transient-perf-harness.ts <config.json> \
 *       [--end <s>] [--out <result.json>] [--quiet] \
 *       [--set <settingsKey>=<value> ...]
 *
 * --set overrides one top-level `settings` field (repeatable); the value is
 * parsed as JSON when it parses, else taken as a string — e.g.
 * `--set closureFluidState=lagged --set dt=0.125`.
 *
 * Prints, per step: simulated time, wall ms, Newton residual evaluations,
 * Jacobian builds, dense solves, custom-h expression evaluations, property
 * calls and property wall (src/core/perf.ts exact attribution).  With --out,
 * writes the full TransientResult (for before/after equivalence checks with
 * scripts/compare-transient-results.ts).
 *
 * Absolute wall times are machine- and load-dependent; the per-step counts
 * are the durable quantities.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  decodeNetworkConfig,
  getPerfSnapshot,
  initRealFluids,
  networkUsesRealFluid,
  setPerfEnabled,
  solveTransient,
  validateNetwork,
  type PerfSnapshot,
} from "../src/core";

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error(
    "usage: tsx scripts/transient-perf-harness.ts <config.json> [--end s] [--out f] [--quiet]",
  );
  process.exit(2);
}
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const endOverride = opt("--end");
const outFile = opt("--out");
const quiet = args.includes("--quiet");

const t0 = performance.now();
const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
const config = decodeNetworkConfig(raw);
if (endOverride !== undefined) config.settings.endTime = Number(endOverride);
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--set") continue;
  const kv = args[i + 1] ?? "";
  const eq = kv.indexOf("=");
  if (eq <= 0) {
    console.error(`--set expects key=value, got "${kv}"`);
    process.exit(2);
  }
  const raw = kv.slice(eq + 1);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  (config.settings as Record<string, unknown>)[kv.slice(0, eq)] = value;
}
const tDecode = performance.now();
const errors = validateNetwork(config);
const tValidate = performance.now();
if (errors.length > 0) {
  console.error("validation errors:", errors.slice(0, 5));
}
if (networkUsesRealFluid(config)) await initRealFluids();
const tInit = performance.now();

// No exact-key sets: they grow without bound on long runs (GC thrash).
setPerfEnabled(true, { trackUniqueKeys: false });
let prev: PerfSnapshot = getPerfSnapshot();
let prevWall = performance.now();
let prevStep = 0;
const sumCalls = (s: PerfSnapshot): number =>
  Object.values(s.propertyCalls).reduce((a, b) => a + b, 0);
const rows: string[] = [];
const solveStart = performance.now();
const result = solveTransient(config, {
  progressInterval: 1,
  onProgress: (p) => {
    const now = performance.now();
    const s = getPerfSnapshot();
    if (p.step > 0) {
      const n = p.step - prevStep;
      const row = [
        p.time.toFixed(2).padStart(7),
        ((now - prevWall) / n).toFixed(1).padStart(9),
        String((s.residualCalls - prev.residualCalls) / n).padStart(7),
        String(
          (s.jacobianBuilds.hybrid +
            s.jacobianBuilds.fd -
            prev.jacobianBuilds.hybrid -
            prev.jacobianBuilds.fd) /
            n,
        ).padStart(5),
        String((s.denseSolveCalls - prev.denseSolveCalls) / n).padStart(6),
        String((s.customHEvals - prev.customHEvals) / n).padStart(7),
        ((s.customHMs - prev.customHMs) / n).toFixed(1).padStart(9),
        String((sumCalls(s) - sumCalls(prev)) / n).padStart(8),
        ((s.propertyMs - prev.propertyMs) / n).toFixed(1).padStart(9),
        String(s.outerItersSkipped - prev.outerItersSkipped).padStart(6),
      ].join(" ");
      rows.push(row);
      if (!quiet) console.log(row);
    } else if (!quiet) {
      console.log(
        "      t   wall_ms  resid  jac  solve  hEvals   h_ms     props  prop_ms  skip",
      );
    }
    prev = s;
    prevWall = now;
    prevStep = p.step;
  },
});
const solveEnd = performance.now();
function outerSummary(xs: number[] | undefined) {
  if (!xs || xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return {
    max: sorted[sorted.length - 1],
    median:
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    total: xs.reduce((a, b) => a + b, 0),
  };
}
const snap = getPerfSnapshot();
setPerfEnabled(false);

console.log(
  JSON.stringify(
    {
      file,
      endTime: config.settings.endTime,
      steps: result.times.length - 1,
      converged: result.converged,
      settings: {
        dt: config.settings.dt,
        closureFluidState: config.settings.closureFluidState,
        maxOuterIterations: config.settings.maxOuterIterations,
      },
      outerIterations: outerSummary(result.stepOuterIterations),
      outerCapSteps: result.outerCapSteps,
      wallMs: {
        readDecode: Math.round(tDecode - t0),
        validate: Math.round(tValidate - tDecode),
        initFluids: Math.round(tInit - tValidate),
        solve: Math.round(solveEnd - solveStart),
      },
      totals: snap,
    },
    null,
    1,
  ),
);
if (outFile) writeFileSync(outFile, JSON.stringify(result));
