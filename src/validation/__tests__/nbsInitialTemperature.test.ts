import { describe, it, expect } from "vitest";
import {
  CORPUS_INITIAL_WALL_TEMPERATURE,
  initialWallTemperatureForPoint,
  initialWallTemperatureForRun,
  runInitialWallTemperature,
} from "../nbsInitialTemperature";
import { NBS_CHILLDOWN_DATA } from "../nbsChilldown";
import { NBS_TRACE_RUNS, getTraceRun } from "../nbsTraceCorpus";

describe("initial wall temperature of the NBS 9264 runs", () => {
  it("is the median of the four first samples and lies within their range", () => {
    for (const run of NBS_TRACE_RUNS) {
      const i = runInitialWallTemperature(run);
      expect(i.perStationK).toHaveLength(4);
      expect(i.medianK).toBeGreaterThanOrEqual(i.minK);
      expect(i.medianK).toBeLessThanOrEqual(i.maxK);
      const s = [...i.perStationK].sort((a, b) => a - b);
      expect(i.medianK).toBeCloseTo(0.5 * (s[1] + s[2]), 12);
      expect(initialWallTemperatureForRun(run)).toBe(i.medianK);
    }
  });

  it("the digitized traces start between about 269 and 307 K (ambient), not at 300 K", () => {
    const all = NBS_TRACE_RUNS.flatMap(
      (r) => runInitialWallTemperature(r).perStationK,
    );
    expect(Math.min(...all)).toBeGreaterThan(265);
    expect(Math.max(...all)).toBeLessThan(310);
    expect(Math.max(...all) - Math.min(...all)).toBeGreaterThan(30);
  });

  it("Fig. 12 starts at 306.8 K at every station", () => {
    expect(
      runInitialWallTemperature(getTraceRun("nbs9264-fig12")).medianK,
    ).toBeCloseTo(306.76, 2);
  });

  it("nine Table-6 rows take their run's value, the other nine the corpus mean", () => {
    const fromTrace = NBS_CHILLDOWN_DATA.filter(
      (p) => initialWallTemperatureForPoint(p).source === "trace",
    );
    expect(fromTrace).toHaveLength(9);
    for (const p of NBS_CHILLDOWN_DATA) {
      const c = initialWallTemperatureForPoint(p);
      if (c.source === "trace")
        expect(c.K).toBe(initialWallTemperatureForRun(getTraceRun(c.runId!)));
      else expect(c.K).toBe(CORPUS_INITIAL_WALL_TEMPERATURE.meanK);
    }
  });

  it("the corpus mean sits inside its own bracket", () => {
    const c = CORPUS_INITIAL_WALL_TEMPERATURE;
    expect(c.runs).toBe(11);
    expect(c.minK).toBeLessThan(c.meanK);
    expect(c.meanK).toBeLessThan(c.maxK);
    expect(c.meanK).toBeGreaterThan(280);
    expect(c.meanK).toBeLessThan(295);
  });
});
