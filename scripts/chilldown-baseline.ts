/**
 * chilldown-baseline.ts — manual, timeout-guarded baseline sweep for the
 * NBS/GFSSP Table-6 LN2 chilldown cases (too slow for CI; the CI proxy
 * lives in src/ui/tests/chilldownBaseline.test.ts).
 *
 * Usage:
 *   npx tsx scripts/chilldown-baseline.ts [--n=3,4,6] [--groups=sat,sub]
 *                                         [--timeout=280] [--tag=label]
 *                                         [--outletT=300]
 *
 * For every (group, driving pressure, N) it solves buildChilldownTwoPhase
 * with timeStepping:'fixed' (REQUIRED — adaptive stepping makes dt a
 * discontinuous function of parameters and destroys differentiability),
 * computes our predicted chilldown time at the true station positions
 * with the smooth crossing (src/validation/), and prints a markdown
 * table: N | driving P | exp (NBS) | GFSSP | ours | our err % | GFSSP
 * err %, plus the definitional-sensitivity row (threshold margins,
 * station choice) underneath.
 *
 * All solves use the 'upwind' outlet-wall coupling so the last wall node
 * chills physically and station 4 (60.35 m) is BRACKETED by wall samples.
 */

import { buildChilldownTwoPhase } from "../src/ui/examples";
import {
  solveTransient,
  initRealFluids,
  RealFluid,
  getSolverDiagnostics,
  physicalPosition,
  resetSolverDiagnostics,
  type NetworkConfig,
  type TransientResult,
} from "../src/core";
import {
  getChilldownPoints,
  NBS_CHILLDOWN_RIG,
  type ChilldownDataPoint,
  type ChilldownTimeDefinition,
} from "../src/validation/nbsChilldown";
import {
  predictedChilldownTimeSweep,
  type ChilldownMetricInput,
  type ChilldownMetricResult,
} from "../src/validation/chilldownMetric";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function arg<T>(name: string, dflt: T, parse: (s: string) => T): T {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? parse(hit.split("=")[1]) : dflt;
}
const N_LIST = arg("n", [3, 4], (s) => s.split(",").map(Number));
const GROUPS = arg("groups", ["sat", "sub"], (s) => s.split(","));
const TIMEOUT_S = arg("timeout", 280, Number);
const TAG = arg("tag", "", (s) => s);
// Outlet boundary vapor temperature (K). 300 = builder default (legacy).
// Set lower (e.g. 90) to expose the boundary-energy-backflow artifact
// (outlet vapor node feeding energy back into the last pipe segment).
const OUTLET_T = arg("outletT", 300, Number);
// Initial wall/fluid temperature (K). Default 300 (= legacy builder
// behaviour where initial == outlet). Vary independently to separate the
// outlet-boundary artifact from the (unrecorded) initial-condition
// nuisance parameter.
const INITIAL_T = arg("initialT", 300, Number);
// Time step (s), fixed stepping. 10 s is the baseline; run --dt=5 on a
// case to bound the temporal-discretization error (the smooth crossing
// already recovers sub-step precision, so this should be small).
const DT = arg("dt", 10, Number);

// ---------------------------------------------------------------------------
// Definitions evaluated per case: the primary definition + sensitivities.
// ---------------------------------------------------------------------------
const DEF_PRIMARY: ChilldownTimeDefinition = {
  station: 4,
  threshold: { mode: "aboveLocalTsat", marginK: 15 },
};
const DEF_SENSITIVITY: ChilldownTimeDefinition[] = [
  { station: 4, threshold: { mode: "aboveLocalTsat", marginK: 5 } },
  { station: 4, threshold: { mode: "aboveLocalTsat", marginK: 30 } },
  { station: 4, threshold: { mode: "aboveInletLiquid", marginK: 15 } },
  { station: 4, threshold: { mode: "fixed", valueK: 100 } },
  // Station sensitivity — the old confound (station 3 instead of 4):
  { station: 3, threshold: { mode: "aboveLocalTsat", marginK: 15 } },
];

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------
interface CaseRow {
  point: ChilldownDataPoint;
  N: number;
  solveS: number;
  status: "ok" | "timeout" | "no-crossing";
  primary: ChilldownMetricResult | undefined;
  sweep: ChilldownMetricResult[] | undefined;
  diag: ReturnType<typeof getSolverDiagnostics> | undefined;
  converged: boolean;
}

function buildCaseConfig(p: ChilldownDataPoint, N: number): NetworkConfig {
  const subcooled = p.inletCondition === "subcooled";
  return buildChilldownTwoPhase({
    segments: N,
    length: NBS_CHILLDOWN_RIG.lengthM,
    drivingPressure: p.drivingPressure.pa,
    outletPressure: 101325,
    outletTemperature: OUTLET_T,
    initialTemperature: INITIAL_T,
    ...(subcooled ? { inletTemperature: p.subcooledAtTemperature!.K } : {}),
    outletWallCoupling: "upwind",
    dt: DT,
    endTime: subcooled ? 360 : 300,
    timeStepping: "fixed",
  });
}

function runCase(p: ChilldownDataPoint, N: number, fluid: RealFluid): CaseRow {
  const cfg = buildCaseConfig(p, N);
  const t0 = Date.now();
  const start = process.hrtime.bigint();
  let res: TransientResult;
  let timedOut = false;
  resetSolverDiagnostics();
  res = solveTransient(cfg, {
    shouldAbort: () => {
      const elapsedS = Number(process.hrtime.bigint() - start) / 1e9;
      if (elapsedS > TIMEOUT_S) {
        timedOut = true;
        return true;
      }
      return false;
    },
  });
  const diag = getSolverDiagnostics();
  const solveS = (Date.now() - t0) / 1000;
  if (timedOut || res.aborted) {
    return {
      point: p,
      N,
      solveS,
      status: "timeout",
      primary: undefined,
      sweep: undefined,
      diag,
      converged: res.converged,
    };
  }

  const input: ChilldownMetricInput = {
    timesS: res.times,
    wallXM: cfg.solidNodes!.map((s) => physicalPosition(s)?.x ?? s.x),
    wallTracesK: cfg.solidNodes!.map((s) => res.solidNodes![s.id].temperature),
    fluidXM: cfg.nodes.map((n) => physicalPosition(n)?.x ?? n.x),
    pressureTracesPa: cfg.nodes.map((n) => res.nodes[n.id].pressure),
    inletLiquidTempK: subcooledTsatOrRef(p, fluid),
    saturationTemperatureK: (pPa) => fluid.saturationTemperature(pPa),
  };
  const [primary, ...sweep] = predictedChilldownTimeSweep(input, [
    DEF_PRIMARY,
    ...DEF_SENSITIVITY,
  ]);
  return {
    point: p,
    N,
    solveS,
    status: primary.timeS === undefined ? "no-crossing" : "ok",
    primary,
    sweep,
    diag,
    converged: res.converged,
  };
}

/** Inlet liquid temperature: Tsat(P_driving) for saturated; the subcooling ref otherwise. */
function subcooledTsatOrRef(p: ChilldownDataPoint, fluid: RealFluid): number {
  if (p.inletCondition === "subcooled") return p.subcooledAtTemperature!.K;
  return fluid.saturationTemperature(p.drivingPressure.pa);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await initRealFluids();
  const fluid = new RealFluid("Nitrogen");
  const L = NBS_CHILLDOWN_RIG.lengthM;

  const points: ChilldownDataPoint[] = [];
  if (GROUPS.includes("sat"))
    points.push(...getChilldownPoints("LN2", "saturated"));
  if (GROUPS.includes("sub"))
    points.push(...getChilldownPoints("LN2", "subcooled"));

  console.log(
    `\n<!-- chilldown-baseline run ${TAG} N=[${N_LIST}] groups=${GROUPS} timeout=${TIMEOUT_S}s outletT=${OUTLET_T} -->\n`,
  );
  console.log(
    `L=${L} m, dt=${DT} s fixed, upwind outlet-wall coupling, outletT=${OUTLET_T} K, initialT=${INITIAL_T} K, primary def: station 4, Tsat_local+15 K\n`,
  );
  console.log(
    "| group | N | P_drive (psia) | exp (s) | GFSSP (s) | ours (s) | our err | GFSSP err | solve (s) | conv | hFloorClamp | PH-fallback (f/p/s/l) |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");

  const sensRows: string[] = [];
  for (const N of N_LIST) {
    for (const p of points) {
      const row = runCase(p, N, fluid);
      const g = p.inletCondition === "saturated" ? "sat" : "sub";
      const d = row.diag;
      const diagStr = d
        ? `${d.hFloorClampCount} | ${d.statePHFallbackCount.freshFactory}/${d.statePHFallbackCount.propsSI}/${d.statePHFallbackCount.saturationDome}/${d.statePHFallbackCount.lastResort}`
        : "— | —";
      if (row.status !== "ok") {
        console.log(
          `| ${g} | ${N} | ${p.drivingPressure.psia} | ${p.experimentalChilldownTimeS} | ${p.gfsspPredictedChilldownTimeS} | **${row.status}** | — | — | ${row.solveS.toFixed(0)} | ${row.converged} | ${diagStr} |`,
        );
        sensRows.push(
          `| ${g} | ${N} | ${p.drivingPressure.psia} | — | — | — | — | — | — |`,
        );
        continue;
      }
      const ours = row.primary!.timeS!;
      const ourErr =
        ((ours - p.experimentalChilldownTimeS) / p.experimentalChilldownTimeS) *
        100;
      const gfsspErr =
        ((p.gfsspPredictedChilldownTimeS - p.experimentalChilldownTimeS) /
          p.experimentalChilldownTimeS) *
        100;
      console.log(
        `| ${g} | ${N} | ${p.drivingPressure.psia} | ${p.experimentalChilldownTimeS} | ${p.gfsspPredictedChilldownTimeS} | ${ours.toFixed(1)} | ${ourErr >= 0 ? "+" : ""}${ourErr.toFixed(1)}% | ${gfsspErr >= 0 ? "+" : ""}${gfsspErr.toFixed(1)}% | ${row.solveS.toFixed(0)} | ${row.converged} | ${diagStr} |`,
      );
      const fmt = (r: ChilldownMetricResult) =>
        r.timeS === undefined ? "none" : r.timeS.toFixed(1);
      // sweep order: m=5, m=30, inlet+15, 100K, sta3 (primary m=15 in main table)
      sensRows.push(
        `| ${g} | ${N} | ${p.drivingPressure.psia} | ${fmt(row.sweep![0])} | ${fmt(row.sweep![1])} | ${fmt(row.sweep![2])} | ${fmt(row.sweep![3])} | ${fmt(row.sweep![4])} |`,
      );
    }
  }

  console.log(
    "\nDefinitional sensitivity (same solves; primary = Tsat_local+15 K @ station 4):\n",
  );
  console.log(
    "| group | N | P_drive (psia) | Tsat_l+5 | Tsat_l+30 | T_inlet+15 | fixed 100 K | station 3 |",
  );
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of sensRows) console.log(r);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
