/**
 * Unit tests for the NBS chilldown validation data module.
 *
 * Conversion checks are hand-verified:
 *   74.97 psia × 6894.757293 Pa/psi = 516,900 Pa   (≈ 517 kPa)
 *   (−411.06 °F − 32) × 5/9 + 273.15 = 27.006 K
 *   (−322.87 °F − 32) × 5/9 + 273.15 = 76.000 K    (subcooled LN2)
 *   141 ft × 0.3048 = 42.9768 m;  198 ft × 0.3048 = 60.3504 m
 */

import { describe, it, expect } from 'vitest';
import {
  PA_PER_PSI,
  psiaToPa,
  degFtoK,
  ftToM,
  inchToM,
  NBS_CHILLDOWN_RIG,
  NBS_CHILLDOWN_DATA,
  NBS_CHILLDOWN_TRACES,
  NBS_CHILLDOWN_UNCERTAINTY_NOTES,
  DEFAULT_CHILLDOWN_TIME_DEFINITION,
  getChilldownPoints,
  stationXM,
  type DigitizedWallTempTrace,
} from '../nbsChilldown';

describe('unit conversions', () => {
  it('psiaToPa: exact factor and hand-verified cases', () => {
    expect(PA_PER_PSI).toBeCloseTo(6894.757293168, 9);
    expect(psiaToPa(74.97)).toBeCloseTo(516900, 0); // 74.97 psi = 516.9 kPa
    expect(psiaToPa(1)).toBeCloseTo(6894.757, 3);
  });

  it('degFtoK: hand-verified cases', () => {
    expect(degFtoK(32)).toBeCloseTo(273.15, 6);
    expect(degFtoK(-411.06)).toBeCloseTo(27.006, 2); // sat LH2 @ 74.97 psia → 27.0 K
    expect(degFtoK(-322.87)).toBeCloseTo(76.0, 2); // subcooled LN2 reference
    expect(degFtoK(-424.57)).toBeCloseTo(19.5, 2); // subcooled LH2 reference
    expect(degFtoK(-294.09)).toBeCloseTo(91.989, 2); // sat LN2 @ 61.74 psia
  });

  it('ftToM / inchToM', () => {
    expect(ftToM(200)).toBeCloseTo(60.96, 9);
    expect(ftToM(141)).toBeCloseTo(42.9768, 4);
    expect(ftToM(198)).toBeCloseTo(60.3504, 4);
    expect(inchToM(0.625)).toBeCloseTo(0.015875, 9);
    expect(inchToM(0.75)).toBeCloseTo(0.01905, 9);
  });
});

describe('NBS rig geometry (single source of truth)', () => {
  it('matches the published geometry', () => {
    expect(NBS_CHILLDOWN_RIG.lengthM).toBeCloseTo(60.96, 9);
    expect(NBS_CHILLDOWN_RIG.innerDiameterM).toBeCloseTo(0.015875, 9);
    expect(NBS_CHILLDOWN_RIG.outerDiameterM).toBeCloseTo(0.01905, 9);
    expect(NBS_CHILLDOWN_RIG.vacuumJacketed).toBe(true);
    expect(NBS_CHILLDOWN_RIG.material).toBe('copper');
  });

  it('stations at 20/80/141/198 ft (primary-source verified)', () => {
    const xs = NBS_CHILLDOWN_RIG.stations.map((s) => s.xM);
    expect(xs).toHaveLength(4);
    expect(xs[0]).toBeCloseTo(6.096, 9);
    expect(xs[1]).toBeCloseTo(24.384, 9);
    expect(xs[2]).toBeCloseTo(42.98, 2);
    expect(xs[3]).toBeCloseTo(60.35, 2);
    // strictly ascending, all inside the line
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    expect(xs[3]).toBeLessThan(NBS_CHILLDOWN_RIG.lengthM);
    expect(stationXM(4)).toBeCloseTo(60.3504, 4);
  });
});

describe('Table 6 dataset integrity', () => {
  it('contains exactly 18 points with the published group split', () => {
    expect(NBS_CHILLDOWN_DATA).toHaveLength(18);
    expect(getChilldownPoints('LH2', 'saturated')).toHaveLength(4);
    expect(getChilldownPoints('LH2', 'subcooled')).toHaveLength(6);
    expect(getChilldownPoints('LN2', 'saturated')).toHaveLength(3);
    expect(getChilldownPoints('LN2', 'subcooled')).toHaveLength(5);
    const ids = new Set(NBS_CHILLDOWN_DATA.map((p) => p.id));
    expect(ids.size).toBe(18);
  });

  it('spot-checks rows against the verified transcription', () => {
    const satLn2Mid = NBS_CHILLDOWN_DATA.find((p) => p.id === 'satLN2-P74.97')!;
    expect(satLn2Mid.drivingPressure.psia).toBe(74.97);
    expect(satLn2Mid.drivingPressure.pa).toBeCloseTo(516900, 0);
    expect(satLn2Mid.saturationTemperature!.degF).toBe(-289.71);
    expect(satLn2Mid.saturationTemperature!.K).toBeCloseTo(94.422, 2);
    expect(satLn2Mid.experimentalChilldownTimeS).toBe(150);
    expect(satLn2Mid.gfsspPredictedChilldownTimeS).toBe(160);

    const subLn2Low = NBS_CHILLDOWN_DATA.find((p) => p.id === 'subLN2-P36.75')!;
    expect(subLn2Low.subcooledAtTemperature!.K).toBeCloseTo(76.0, 2);
    expect(subLn2Low.experimentalChilldownTimeS).toBe(222);
    expect(subLn2Low.gfsspPredictedChilldownTimeS).toBe(250);
  });

  it('carries provenance and uncertainty on every point', () => {
    for (const p of NBS_CHILLDOWN_DATA) {
      expect(p.provenance.sourceTable).toContain('Table 6');
      expect(p.provenance.underlyingExperiment).toContain('NBS-9264');
      expect(p.uncertainty.timeS).toBeGreaterThan(0);
      expect(p.uncertainty.basis.length).toBeGreaterThan(0);
      expect(p.uncertainty.notes.length).toBeGreaterThanOrEqual(1);
    }
    expect(NBS_CHILLDOWN_UNCERTAINTY_NOTES.length).toBeGreaterThanOrEqual(5);
  });

  it('physical trend: chilldown time strictly decreases with driving pressure', () => {
    for (const fluid of ['LH2', 'LN2'] as const) {
      for (const cond of ['saturated', 'subcooled'] as const) {
        const pts = getChilldownPoints(fluid, cond).sort(
          (a, b) => a.drivingPressure.pa - b.drivingPressure.pa
        );
        for (let i = 1; i < pts.length; i++) {
          expect(pts[i].experimentalChilldownTimeS).toBeLessThan(
            pts[i - 1].experimentalChilldownTimeS
          );
        }
      }
    }
  });

  it('GFSSP published predictions are within ±20% of experiment (sanity bound)', () => {
    for (const p of NBS_CHILLDOWN_DATA) {
      const err =
        (p.gfsspPredictedChilldownTimeS - p.experimentalChilldownTimeS) /
        p.experimentalChilldownTimeS;
      expect(Math.abs(err)).toBeLessThanOrEqual(0.2);
    }
  });

  it('subcooling reduces chilldown time at matched pressure (Table-6 pattern)', () => {
    for (const pSat of getChilldownPoints('LN2', 'saturated')) {
      const pSub = getChilldownPoints('LN2', 'subcooled').find(
        (q) => Math.abs(q.drivingPressure.psia - pSat.drivingPressure.psia) < 0.02
      );
      expect(pSub).toBeDefined();
      expect(pSub!.experimentalChilldownTimeS).toBeLessThan(pSat.experimentalChilldownTimeS);
    }
  });
});

describe('chilldown-time definition + future traces shape', () => {
  it('default definition: station 4 knee, local-Tsat + 15 K', () => {
    expect(DEFAULT_CHILLDOWN_TIME_DEFINITION.station).toBe(4);
    expect(DEFAULT_CHILLDOWN_TIME_DEFINITION.threshold).toEqual({
      mode: 'aboveLocalTsat',
      marginK: 15,
    });
  });

  it('traces array is empty but has the explicit drop-in shape', () => {
    expect(NBS_CHILLDOWN_TRACES).toEqual([]);
    // Compile-time shape demonstration: a conforming object is assignable.
    const example: DigitizedWallTempTrace = {
      runId: 'nbs9264-fig12',
      conditionId: 'satLN2-P61.74',
      station: 4,
      timesS: [0, 10, 20],
      wallTempsK: [300, 200, 95],
      provenance: { sourceDoc: 'NBS-9264', figure: 'Fig. 12', page: 25 },
      digitizationMethod: 'WebPlotDigitizer',
      estimatedUncertainty: { timeS: 1, tempK: 3, notes: ['demo'] },
    };
    expect(example.station).toBe(4);
  });
});
