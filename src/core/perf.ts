/**
 * Opt-in exact-attribution profiler for real-fluid solves.
 *
 * Off by default: hot paths take one boolean check. Enable around a solve
 * from a study script (scripts/real-fluid-performance.ts) — never from the
 * product UI. Timers use `performance.now()` so the same code runs in Node
 * and in the browser worker.
 *
 * Property time is reentrant: nested getSatProps-inside-statePH does not
 * double-count wall. Call counts still increment at every entry.
 */

export type PropertyCallKind =
  | "statePH"
  | "derivativesPH"
  | "internalEnergyPH"
  | "getSatProps"
  | "getSatDerivs"
  | "ptFlash"
  | "reportingPH"
  | "other";

/** Entry points backed by a bounded LRU value cache in realFluid.ts. */
export type PHCacheKind = "statePH" | "derivativesPH" | "internalEnergyPH";

export interface PerfSnapshot {
  /** Inclusive wall of every instrumented property entry (reentrant). */
  propertyMs: number;
  denseSolveMs: number;
  denseSolveCalls: number;
  propertyCalls: Record<PropertyCallKind, number>;
  /**
   * Calls answered from the bounded LRU value caches (realFluid.ts) —
   * these entries never reached CoolProp. Realized hit rate for a kind is
   * `cacheHits[kind] / propertyCalls[kind]`.
   */
  cacheHits: Record<PHCacheKind, number>;
  residualCalls: number;
  residualCallsInJacobian: number;
  jacobianBuilds: { hybrid: number; fd: number };
  /**
   * Distinct (fluid, P, h) IEEE keys seen by statePH (recorded at entry,
   * cache hits included). The exact-key ceiling on the LRU hit rate is
   * `1 - uniqueStatePH / propertyCalls.statePH`
   * (0 when there were no statePH calls).
   */
  uniqueStatePH: number;
  uniqueInternalEnergyPH: number;
}

const EMPTY_CALLS = (): Record<PropertyCallKind, number> => ({
  statePH: 0,
  derivativesPH: 0,
  internalEnergyPH: 0,
  getSatProps: 0,
  getSatDerivs: 0,
  ptFlash: 0,
  reportingPH: 0,
  other: 0,
});

const EMPTY_CACHE_HITS = (): Record<PHCacheKind, number> => ({
  statePH: 0,
  derivativesPH: 0,
  internalEnergyPH: 0,
});

export let perfEnabled = false;

let propertyMs = 0;
let propertyDepth = 0;
let propertyStart = 0;
let denseSolveMs = 0;
let denseSolveCalls = 0;
let denseDepth = 0;
let denseStart = 0;
let propertyCalls = EMPTY_CALLS();
let cacheHits = EMPTY_CACHE_HITS();
let residualCalls = 0;
let residualCallsInJacobian = 0;
let jacobianHybrid = 0;
let jacobianFd = 0;
let jacobianDepth = 0;
const statePHKeys = new Set<string>();
const internalEnergyPHKeys = new Set<string>();

export function setPerfEnabled(on: boolean): void {
  perfEnabled = on;
  resetPerf();
}

export function resetPerf(): void {
  propertyMs = 0;
  propertyDepth = 0;
  denseSolveMs = 0;
  denseSolveCalls = 0;
  denseDepth = 0;
  propertyCalls = EMPTY_CALLS();
  cacheHits = EMPTY_CACHE_HITS();
  residualCalls = 0;
  residualCallsInJacobian = 0;
  jacobianHybrid = 0;
  jacobianFd = 0;
  jacobianDepth = 0;
  statePHKeys.clear();
  internalEnergyPHKeys.clear();
}

export function enterProperty(kind: PropertyCallKind): void {
  if (!perfEnabled) return;
  propertyCalls[kind]++;
  if (propertyDepth++ === 0) propertyStart = performance.now();
}

export function leaveProperty(): void {
  if (!perfEnabled) return;
  if (propertyDepth === 0) return;
  if (--propertyDepth === 0) {
    propertyMs += performance.now() - propertyStart;
  }
}

export function recordCacheHit(kind: PHCacheKind): void {
  if (!perfEnabled) return;
  cacheHits[kind]++;
}

export function recordPHKey(
  kind: "statePH" | "internalEnergyPH",
  fluidName: string,
  P: number,
  h: number,
): void {
  if (!perfEnabled) return;
  const key = `${fluidName}\0${P}\0${h}`;
  if (kind === "statePH") statePHKeys.add(key);
  else internalEnergyPHKeys.add(key);
}

export function enterDenseSolve(): void {
  if (!perfEnabled) return;
  denseSolveCalls++;
  if (denseDepth++ === 0) denseStart = performance.now();
}

export function leaveDenseSolve(): void {
  if (!perfEnabled) return;
  if (denseDepth === 0) return;
  if (--denseDepth === 0) {
    denseSolveMs += performance.now() - denseStart;
  }
}

export function recordResidualEval(): void {
  if (!perfEnabled) return;
  residualCalls++;
  if (jacobianDepth > 0) residualCallsInJacobian++;
}

export function enterJacobian(kind: "hybrid" | "fd"): void {
  if (!perfEnabled) return;
  if (kind === "hybrid") jacobianHybrid++;
  else jacobianFd++;
  jacobianDepth++;
}

export function leaveJacobian(): void {
  if (!perfEnabled) return;
  if (jacobianDepth > 0) jacobianDepth--;
}

export function getPerfSnapshot(): PerfSnapshot {
  return {
    propertyMs,
    denseSolveMs,
    denseSolveCalls,
    propertyCalls: { ...propertyCalls },
    cacheHits: { ...cacheHits },
    residualCalls,
    residualCallsInJacobian,
    jacobianBuilds: { hybrid: jacobianHybrid, fd: jacobianFd },
    uniqueStatePH: statePHKeys.size,
    uniqueInternalEnergyPH: internalEnergyPHKeys.size,
  };
}
