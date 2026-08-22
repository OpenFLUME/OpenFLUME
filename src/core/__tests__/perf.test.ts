/**
 * Opt-in profiler API — no CoolProp, safe for the fast suite.
 *
 * The timers themselves are exercised by scripts/real-fluid-performance.ts
 * on real solves; this file only pins enable/disable, snapshot isolation,
 * and reentrancy.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  setPerfEnabled,
  resetPerf,
  getPerfSnapshot,
  enterProperty,
  leaveProperty,
  recordPHKey,
  recordCacheHit,
  enterDenseSolve,
  leaveDenseSolve,
  recordResidualEval,
  enterJacobian,
  leaveJacobian,
  perfEnabled,
} from "../perf";

afterEach(() => {
  setPerfEnabled(false);
});

describe("perf profiler", () => {
  it("is off by default and snapshots are empty", () => {
    expect(perfEnabled).toBe(false);
    const snap = getPerfSnapshot();
    expect(snap.propertyMs).toBe(0);
    expect(snap.propertyCalls.statePH).toBe(0);
    expect(snap.residualCalls).toBe(0);
    expect(snap.uniqueStatePH).toBe(0);
  });

  it("records reentrant property time without double-counting nested calls", () => {
    setPerfEnabled(true);
    enterProperty("statePH");
    enterProperty("getSatProps");
    leaveProperty();
    leaveProperty();
    const snap = getPerfSnapshot();
    expect(snap.propertyCalls.statePH).toBe(1);
    expect(snap.propertyCalls.getSatProps).toBe(1);
    expect(snap.propertyMs).toBeGreaterThanOrEqual(0);
  });

  it("attributes residual evals inside an open Jacobian build", () => {
    setPerfEnabled(true);
    recordResidualEval();
    enterJacobian("hybrid");
    recordResidualEval();
    recordResidualEval();
    leaveJacobian();
    recordResidualEval();
    const snap = getPerfSnapshot();
    expect(snap.residualCalls).toBe(4);
    expect(snap.residualCallsInJacobian).toBe(2);
    expect(snap.jacobianBuilds.hybrid).toBe(1);
  });

  it("counts would-be exact-key memoization keys", () => {
    setPerfEnabled(true);
    recordPHKey("statePH", "Nitrogen", 1e5, 1e5);
    recordPHKey("statePH", "Nitrogen", 1e5, 1e5);
    recordPHKey("statePH", "Nitrogen", 2e5, 1e5);
    enterProperty("statePH");
    enterProperty("statePH");
    enterProperty("statePH");
    leaveProperty();
    leaveProperty();
    leaveProperty();
    const snap = getPerfSnapshot();
    expect(snap.uniqueStatePH).toBe(2);
    expect(snap.propertyCalls.statePH).toBe(3);
  });

  it("counts LRU value-cache hits per kind, gated on the enabled flag", () => {
    recordCacheHit("statePH"); // disabled: must not count
    setPerfEnabled(true);
    recordCacheHit("statePH");
    recordCacheHit("statePH");
    recordCacheHit("derivativesPH");
    const snap = getPerfSnapshot();
    expect(snap.cacheHits.statePH).toBe(2);
    expect(snap.cacheHits.derivativesPH).toBe(1);
    expect(snap.cacheHits.internalEnergyPH).toBe(0);
    resetPerf();
    expect(getPerfSnapshot().cacheHits.statePH).toBe(0);
  });

  it("reset clears accumulators while leaving the enabled flag", () => {
    setPerfEnabled(true);
    enterDenseSolve();
    leaveDenseSolve();
    recordResidualEval();
    resetPerf();
    expect(perfEnabled).toBe(true);
    const snap = getPerfSnapshot();
    expect(snap.denseSolveCalls).toBe(0);
    expect(snap.residualCalls).toBe(0);
  });

  it("snapshot is a copy", () => {
    setPerfEnabled(true);
    enterProperty("statePH");
    leaveProperty();
    const snap = getPerfSnapshot();
    snap.propertyCalls.statePH = 999;
    expect(getPerfSnapshot().propertyCalls.statePH).toBe(1);
  });
});
