/**
 * chilldown-solves.ts — isolated, parallel NBS 9264 chilldown solves for
 * the validation report.
 *
 * Every solve runs in a child process with a timeout.  Refined subcooled
 * solves are long (minutes), and a solve that runs without end or aborts
 * inside CoolProp-wasm must be reported as such, not dropped; after an
 * abort the wasm module is unusable for every later solve in the process,
 * so a failure must not take the other solves down.  The parent runs the
 * jobs through a small pool (children are single-threaded).
 *
 * The child (this file run with --child=<json>) builds the network of one
 * SolveSpec, solves it and prints one `RESULT {json}` line: the model's
 * wall and pressure histories and, on request, the diagnostics used to
 * explain a result (branch shares of the wall heat, the end node's state,
 * mass-flow histories).  The parent computes every metric from the
 * histories, so a definition change never needs a re-solve.
 */

import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { buildChilldownTwoPhase } from "../../src/ui/examples";
import {
  initRealFluids,
  physicalPosition,
  solveTransient,
  type NetworkConfig,
  type TransientResult,
} from "../../src/core";
import {
  NBS_CHILLDOWN_DATA,
  NBS_CHILLDOWN_RIG,
  NBS_LINE_WALL_MODEL,
  NBS_LINE_WALL_MODEL_LEGACY,
} from "../../src/validation/nbsChilldown";
import { getTraceRun } from "../../src/validation/nbsTraceCorpus";
import { nistOfhcCopperCpFit } from "../../src/core/solidProperties";

export interface SolveSpec {
  /** Table-6 row id ('satLN2-P74.97') or digitized run id ('nbs9264-fig12'). */
  id: string;
  N: number;
  dtS: number;
  /** Uniform initial wall/fluid temperature (K); omitted = the builder's 300 K. */
  initialK?: number;
  /** CoolProp fluid override (default: Nitrogen / ParaHydrogen by the row's fluid). */
  fluidName?: string;
  endTimeS: number;
  /** Wall discretization; default NBS_LINE_WALL_MODEL. 'legacy' = the
   *  pre-GFSSP-layout coupling (end walls borrowing a neighbour). */
  layout?: "nbs" | "legacy";
  correlation?: "miropolskii" | "darrHartwig";
  /** Also return the explanatory diagnostics. */
  diag?: boolean;
}

export interface SolveDiag {
  /** Wall heat released to the fluid [J], by the phase of the fluid node
   *  that the conductor sat on at that step. */
  wallHeatByPhaseJ: Record<string, number>;
  /** Total wall energy removed (from the wall temperature history) [J]. */
  wallEnergyRemovedJ: number;
  /** Fluid-side energy gain [J]: ∫ (ṁ_out h_out − ṁ_in h_in) dt + Δ(ρ u V)
   *  over the internal nodes — equals the wall heat if the energy closes. */
  fluidEnthalpyGainJ: number;
  /** Mass in, mass out [kg]. */
  massInKg: number;
  massOutKg: number;
  /** Inlet and outlet branch mass flow histories [kg/s]. */
  mdotInKgS: number[];
  mdotOutKgS: number[];
  /** The fluid node of the last wall node and that wall's history. */
  endNode: {
    id: string;
    xM: number;
    temperatureK: number[];
    quality: (number | null)[];
    phase: string[];
    pressurePa: number[];
    hWmK: number[];
    wallTemperatureK: number[];
    heatRateW: number[];
  };
}

export interface SolveOut {
  spec: SolveSpec;
  converged: boolean;
  /** Scaled residual > 0.01 steps (stalled) — indices. */
  stalledSteps: number[];
  wallS: number;
  failed?: string;
  timesS: number[];
  wallXM: number[];
  wallTracesK: number[][];
  fluidXM: number[];
  pressureTracesPa: number[][];
  diag?: SolveDiag;
}

const PARA_H2 = "ParaHydrogen";

function isTable6(id: string): boolean {
  return NBS_CHILLDOWN_DATA.some((p) => p.id === id);
}

/** Conditions of a spec: driving pressure, inlet state, default fluid. */
export function specConditions(spec: SolveSpec): {
  drivingPressurePa: number;
  inletTemperatureK?: number;
  fluidName: string;
} {
  if (isTable6(spec.id)) {
    const p = NBS_CHILLDOWN_DATA.find((x) => x.id === spec.id)!;
    return {
      drivingPressurePa: p.drivingPressure.pa,
      inletTemperatureK:
        p.inletCondition === "subcooled"
          ? p.subcooledAtTemperature!.K
          : undefined,
      fluidName: p.fluid === "LH2" ? PARA_H2 : "Nitrogen",
    };
  }
  const run = getTraceRun(spec.id);
  return {
    drivingPressurePa: run.drivingPressure.pa,
    inletTemperatureK:
      run.inletCondition === "subcooled" ? run.inletLiquidTempK : undefined,
    fluidName: run.fluid === "LH2" ? PARA_H2 : "Nitrogen",
  };
}

export function buildSpecConfig(spec: SolveSpec): NetworkConfig {
  const c = specConditions(spec);
  const legacy = spec.layout === "legacy";
  return buildChilldownTwoPhase({
    segments: spec.N,
    length: NBS_CHILLDOWN_RIG.lengthM,
    drivingPressure: c.drivingPressurePa,
    outletPressure: 101325,
    fluidName: spec.fluidName ?? c.fluidName,
    ...(c.inletTemperatureK !== undefined
      ? { inletTemperature: c.inletTemperatureK }
      : {}),
    ...(legacy ? NBS_LINE_WALL_MODEL_LEGACY : NBS_LINE_WALL_MODEL),
    ...(spec.initialK !== undefined
      ? { initialTemperature: spec.initialK }
      : {}),
    ...(spec.correlation ? { correlationModel: spec.correlation } : {}),
    dt: spec.dtS,
    endTime: spec.endTimeS,
    timeStepping: "fixed",
  });
}

function copperEnergyJ(mass: number, T1: number, T0: number): number {
  // m ∫_{T1}^{T0} cp(T) dT, trapezoid on 400 panels (OFHC copper, NIST fit).
  const n = 400;
  let e = 0;
  for (let i = 0; i < n; i++) {
    const a = T1 + ((T0 - T1) * i) / n;
    const b = T1 + ((T0 - T1) * (i + 1)) / n;
    e += 0.5 * (nistOfhcCopperCpFit(a) + nistOfhcCopperCpFit(b)) * (b - a);
  }
  return mass * e;
}

function diagnose(cfg: NetworkConfig, res: TransientResult): SolveDiag {
  const t = res.times;
  const n = t.length;
  const byPhase: Record<string, number> = {};
  const convs = cfg.conductors!.filter((c) => c.id.startsWith("conv"));
  const nodeById = new Map(cfg.nodes.map((x) => [x.id, x]));
  for (const c of convs) {
    const hr = res.conductors![c.id].heatRate;
    const fluidId = nodeById.has(c.from) ? c.from : c.to;
    const phases = res.nodes[fluidId].phase;
    const boundary = nodeById.get(fluidId)!.type === "boundary";
    for (let k = 1; k < n; k++) {
      const cls = boundary ? "boundary" : (phases?.[k] ?? "unknown");
      // Heat rate is negative when the wall loses heat to the fluid.
      byPhase[cls] = (byPhase[cls] ?? 0) - hr[k] * (t[k] - t[k - 1]);
    }
  }
  const walls = cfg.solidNodes!;
  // Wall energy removed from the temperature histories (independent of the
  // heat-rate bookkeeping above).
  const wallEnergy = walls.reduce((sum, w) => {
    const T = res.solidNodes![w.id].temperature;
    return sum + copperEnergyJ(w.mass ?? 0, T[n - 1], T[0]);
  }, 0);
  const inB = cfg.branches[0];
  const outB = cfg.branches[cfg.branches.length - 1];
  const mIn = res.branches[inB.id].mdot;
  const mOut = res.branches[outB.id].mdot;
  const hIn = res.nodes[inB.from].enthalpy!;
  const hOut = res.nodes[outB.from].enthalpy!;
  let massIn = 0;
  let massOut = 0;
  let enthalpyNet = 0;
  for (let k = 1; k < n; k++) {
    const dt = t[k] - t[k - 1];
    massIn += mIn[k] * dt;
    massOut += mOut[k] * dt;
    // Backward Euler: the flows and node states of step k act over (k−1, k].
    enthalpyNet += (mOut[k] * hOut[k] - mIn[k] * hIn[k]) * dt;
  }
  // Fluid inventory energy change ρ u V over the internal nodes.
  let dU = 0;
  for (const nd of cfg.nodes) {
    if (nd.type !== "internal") continue;
    const h = res.nodes[nd.id];
    const uk = (k: number) =>
      h.density[k] * h.internalEnergy![k] * (nd.volume as number);
    dU += uk(n - 1) - uk(0);
  }
  const lastWall = walls[walls.length - 1];
  const lastConv = convs.find((c) => c.to === lastWall.id)!;
  const endId = nodeById.has(lastConv.from) ? lastConv.from : lastConv.to;
  const nd = res.nodes[endId];
  return {
    wallHeatByPhaseJ: byPhase,
    wallEnergyRemovedJ: wallEnergy,
    fluidEnthalpyGainJ: enthalpyNet + dU,
    massInKg: massIn,
    massOutKg: massOut,
    mdotInKgS: mIn,
    mdotOutKgS: mOut,
    endNode: {
      id: endId,
      xM: physicalPosition(nodeById.get(endId)!)?.x ?? NaN,
      temperatureK: nd.temperature,
      quality: (nd.quality ?? nd.temperature.map(() => undefined)).map((q) =>
        q === undefined || !Number.isFinite(q) ? null : q,
      ),
      phase: nd.phase ?? nd.temperature.map(() => "unknown"),
      pressurePa: nd.pressure,
      hWmK: res.conductors![lastConv.id].heatTransferCoeff ?? [],
      wallTemperatureK: res.solidNodes![lastWall.id].temperature,
      heatRateW: res.conductors![lastConv.id].heatRate,
    },
  };
}

/** Child entry: solve one spec and print the RESULT line. */
export async function runChild(spec: SolveSpec): Promise<void> {
  await initRealFluids();
  const cfg = buildSpecConfig(spec);
  const t0 = Date.now();
  const res = solveTransient(cfg);
  const sr = res.stepResidualsScaled ?? [];
  const out: SolveOut = {
    spec,
    converged: res.converged,
    stalledSteps: sr.map((x, i) => (x > 0.01 ? i : -1)).filter((i) => i >= 0),
    wallS: (Date.now() - t0) / 1000,
    timesS: res.times,
    wallXM: cfg.solidNodes!.map((s) => physicalPosition(s)?.x ?? s.x),
    wallTracesK: cfg.solidNodes!.map((s) => res.solidNodes![s.id].temperature),
    fluidXM: cfg.nodes.map((n) => physicalPosition(n)?.x ?? n.x),
    pressureTracesPa: cfg.nodes.map((n) => res.nodes[n.id].pressure),
    ...(spec.diag ? { diag: diagnose(cfg, res) } : {}),
  };
  // Large payload: exit only after the pipe has drained.
  await new Promise<void>((resolve) =>
    process.stdout.write(`RESULT ${JSON.stringify(out)}\n`, () => resolve()),
  );
}

const CHILD_FLAG = "--chilldown-child=";

export function maybeRunAsChild(): boolean {
  const arg = process.argv.find((a) => a.startsWith(CHILD_FLAG));
  if (!arg) return false;
  void runChild(JSON.parse(arg.slice(CHILD_FLAG.length)) as SolveSpec).then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
  return true;
}

export interface SolveJob {
  key: string;
  spec: SolveSpec;
}

/**
 * Run the jobs through a pool of child processes (this module's host script
 * must call maybeRunAsChild() before anything else).  A job that exceeds the
 * timeout, aborts, or exits abnormally returns a SolveOut with `failed` set.
 */
export async function runSolveJobs(
  hostScript: string,
  jobs: SolveJob[],
  opts: {
    timeoutS?: number;
    concurrency?: number;
    log?: (m: string) => void;
  } = {},
): Promise<Map<string, SolveOut>> {
  const timeoutS = opts.timeoutS ?? 1500;
  const concurrency =
    opts.concurrency ?? Math.max(1, Math.min(10, cpus().length - 2));
  const log = opts.log ?? (() => {});
  const results = new Map<string, SolveOut>();
  // Longest first: the pool finishes sooner when the slow solves start early.
  const weight = (s: SolveSpec) =>
    (s.endTimeS / s.dtS) *
    Math.pow(s.N + 1, 1.5) *
    (/LN2|nbs9264-fig1[0-4]/.test(s.id) ? 1.5 : 1);
  const queue = [...jobs].sort((a, b) => weight(b.spec) - weight(a.spec));
  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      if (queue.length === 0 && active === 0) return resolve();
      while (active < concurrency && queue.length > 0) {
        const job = queue.shift()!;
        active++;
        const started = Date.now();
        const child = spawn(
          process.execPath,
          [
            ...process.execArgv,
            hostScript,
            `${CHILD_FLAG}${JSON.stringify(job.spec)}`,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => {
          if (stderr.length < 20000) stderr += d;
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutS * 1000);
        child.on("close", (code) => {
          clearTimeout(timer);
          active--;
          const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
          let out: SolveOut;
          if (line) {
            out = JSON.parse(line.slice(7)) as SolveOut;
          } else {
            const failed = timedOut
              ? `timed out after ${timeoutS} s`
              : /memory access out of bounds|Aborted/.test(stderr + stdout)
                ? "CoolProp abort"
                : `exit ${code}`;
            out = {
              spec: job.spec,
              converged: false,
              stalledSteps: [],
              wallS: (Date.now() - started) / 1000,
              failed,
              timesS: [],
              wallXM: [],
              wallTracesK: [],
              fluidXM: [],
              pressureTracesPa: [],
            };
          }
          results.set(job.key, out);
          log(
            `  ${job.key}: ${out.failed ?? (out.converged ? "ok" : "not converged")} (${out.wallS.toFixed(0)} s)`,
          );
          pump();
        });
      }
    };
    pump();
  });
  return results;
}

export const HOST_SCRIPT_URL = (importMetaUrl: string) =>
  fileURLToPath(importMetaUrl);
