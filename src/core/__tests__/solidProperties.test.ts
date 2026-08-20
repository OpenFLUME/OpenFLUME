/**
 * Solid-property layer tests: NIST OFHC-copper preset validation, table
 * mechanics, spec validation.
 *
 * Provenance (full text in solidProperties.ts): NIST Cryogenic Material
 * Properties Database, OFHC Copper (UNS C10100/C10200), rev. 02/03/2010 —
 * cp: log-log 8th-order polynomial, 4–300 K, stated fit error 10 % (T<15 K) /
 * 5 % (T≥15 K); k: rational polynomial per RRR, 4–300 K, stated 1–2 %.
 * The registry samples these fits adaptively to ≤0.1 % interpolation error.
 */
import { describe, it, expect } from "vitest";
import {
  SOLID_MATERIALS,
  PiecewiseLinearProperty,
  getSolidMaterialTable,
  nistOfhcCopperCpFit,
  nistOfhcCopperKFit,
  resolveSolidProperty,
  validateSolidPropertySpec,
  OFHC_COPPER_ASSUMED_RRR,
  nistAl6061CpFit,
  nistAl6061KFit,
  nistSs304CpFit,
  nistSs304KFit,
  nistSs316CpFit,
  nistSs316KFit,
  anl304LCpFit,
  anl304LKFit,
  anl316LCpFit,
  anl316LKFit,
  inconel718CpFit,
  inconel718KFit,
  INCONEL718_GAP_CP_K,
  INCONEL718_GAP_K_K,
  grcop84CpFit,
  grcop84KFit,
  GRCOP84_TMIN,
  GRCOP84_TMAX,
  nistPtfeCpFit,
  nistPtfeKFit,
  nistG10CpFit,
  nistG10KNormalFit,
  nistG10KWarpFit,
} from "../solidProperties";
import { validateNetwork } from "../validate";
import type { NetworkConfig } from "../schema";

// ---------------------------------------------------------------------------
// Canonical anchor points for OFHC/pure copper cp (J/kg/K), consistent with
// NIST Monograph 177 (Simon-Drexler-Reed 1992, §7-1) and standard cryogenic
// tables; tolerances = the NIST database's own stated fit accuracy.
// ---------------------------------------------------------------------------
const CP_ANCHORS: Array<[number, number, number]> = [
  // [T (K), canonical cp (J/kg/K), rel tolerance]
  [10, 0.86, 0.1], // low-T Debye T³ regime (NIST stated: 10 % below 15 K)
  [20, 7.5, 0.1],
  [77, 193.5, 0.05], // NIST stated: 5 % at/above 15 K
  [150, 324, 0.05],
  [300, 385, 0.05], // room-temperature handbook value 385 J/kg/K
];

describe("NIST OFHC-copper preset — validation against published values", () => {
  const cpTable = getSolidMaterialTable("ofhc-copper", "cp");
  const cpCurve = new PiecewiseLinearProperty(cpTable);

  it("sampled table reproduces the NIST cp fit to ≤0.2 % everywhere in 4–300 K", () => {
    let worst = 0;
    for (let i = 0; i <= 2000; i++) {
      const T = 4 + (296 * i) / 2000;
      const rel =
        Math.abs(cpCurve.value(T) - nistOfhcCopperCpFit(T)) /
        nistOfhcCopperCpFit(T);
      worst = Math.max(worst, rel);
    }
    console.log(
      `cp table-vs-fit worst relative deviation: ${(worst * 100).toFixed(3)} % (${cpTable.length} knots)`,
    );
    expect(worst).toBeLessThan(0.002);
  });

  it.each(CP_ANCHORS)(
    "cp(%d K) within NIST stated accuracy of canonical value",
    (T, canonical, tol) => {
      const fit = nistOfhcCopperCpFit(T);
      const tab = cpCurve.value(T);
      const fitDev = Math.abs(fit - canonical) / canonical;
      console.log(
        `cp(${T} K): fit=${fit.toFixed(3)} table=${tab.toFixed(3)} canonical≈${canonical} (dev ${(fitDev * 100).toFixed(1)} %, tol ${tol * 100} %)`,
      );
      expect(fitDev).toBeLessThan(tol);
      expect(Math.abs(tab - canonical) / canonical).toBeLessThan(tol + 0.002); // + table interp allowance
    },
  );

  it("k table reproduces the NIST k fit (RRR=100) to ≤0.2 %; room-temperature anchor", () => {
    const kTable = getSolidMaterialTable("ofhc-copper", "k");
    const kCurve = new PiecewiseLinearProperty(kTable);
    let worst = 0;
    for (let i = 0; i <= 2000; i++) {
      const T = 4 + (296 * i) / 2000;
      const rel =
        Math.abs(
          kCurve.value(T) - nistOfhcCopperKFit(T, OFHC_COPPER_ASSUMED_RRR),
        ) / nistOfhcCopperKFit(T, OFHC_COPPER_ASSUMED_RRR);
      worst = Math.max(worst, rel);
    }
    console.log(
      `k table-vs-fit worst relative deviation: ${(worst * 100).toFixed(3)} % (${kTable.length} knots)`,
    );
    expect(worst).toBeLessThan(0.002);
    // OFHC copper k(300 K) ≈ 390–400 W/m/K (RRR-insensitive at RT).
    expect(Math.abs(kCurve.value(300) - 395) / 395).toBeLessThan(0.03);
  });

  it("k RRR-dependence has the right sign and a large low-T spread (documented uncertainty)", () => {
    // Higher RRR ⇒ higher k at low T; spread at 20 K is a factor >2 (the reason
    // k is only believable to an RRR bracket at cryogenic temperatures).
    expect(nistOfhcCopperKFit(20, 500)).toBeGreaterThan(
      nistOfhcCopperKFit(20, 100),
    );
    expect(nistOfhcCopperKFit(20, 100)).toBeGreaterThan(
      nistOfhcCopperKFit(20, 50),
    );
    expect(
      nistOfhcCopperKFit(20, 500) / nistOfhcCopperKFit(20, 50),
    ).toBeGreaterThan(2);
    // …while at 300 K the RRR spread nearly vanishes (<3 %).
    expect(
      Math.abs(nistOfhcCopperKFit(300, 500) / nistOfhcCopperKFit(300, 50) - 1),
    ).toBeLessThan(0.03);
  });

  it("fit-value snapshot (drift sentinel) at the four standard check temperatures", () => {
    // Deterministic arithmetic — pin hard.  Values measured 2026-08-06 from the
    // coefficients on the NIST page; any change here means the fit or sampler changed.
    expect(nistOfhcCopperCpFit(300)).toBeCloseTo(389.4015, 3);
    expect(nistOfhcCopperCpFit(77)).toBeCloseTo(195.9209, 3);
    expect(nistOfhcCopperCpFit(20)).toBeCloseTo(7.5061, 3);
    expect(nistOfhcCopperCpFit(4)).toBeCloseTo(0.0994, 3);
    expect(nistOfhcCopperKFit(300, 100)).toBeCloseTo(396.3, 0);
    expect(nistOfhcCopperKFit(20, 100)).toBeCloseTo(2422.5, 0);
  });

  it("registry entry carries provenance and the assumed RRR", () => {
    const m = SOLID_MATERIALS["ofhc-copper"];
    expect(m).toBeDefined();
    expect(m.provenance.source).toContain("NIST");
    expect(m.provenance.url).toContain("trc.nist.gov");
    expect(m.provenance.validityRangeK).toEqual([4, 300]);
    expect(m.provenance.rrrAssumed).toBe(OFHC_COPPER_ASSUMED_RRR);
  });

  it("legacy OFHC table anchors are unchanged by the catalogue expansion", () => {
    // Non-regression: the OFHC entry must keep its original extent and values.
    const cp = new PiecewiseLinearProperty(
      getSolidMaterialTable("ofhc-copper", "cp"),
    );
    const k = new PiecewiseLinearProperty(
      getSolidMaterialTable("ofhc-copper", "k"),
    );
    expect(cp.minT).toBe(4);
    expect(cp.maxT).toBe(300);
    expect(k.minT).toBe(4);
    expect(k.maxT).toBe(300);
    expect(cp.value(300)).toBeCloseTo(389.4015, 2);
    expect(k.value(300)).toBeCloseTo(396.3, 0);
    // ofhc-copper must remain the FIRST registry key: the UI seeds the
    // material mode with Object.keys(SOLID_MATERIALS)[0].
    expect(Object.keys(SOLID_MATERIALS)[0]).toBe("ofhc-copper");
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by the catalogue tests: dense table-vs-source-curve check and
// clamp behaviour.
// ---------------------------------------------------------------------------
function expectTableMatchesFit(
  table: Array<[number, number]>,
  fit: (T: number) => number,
  lo: number,
  hi: number,
  tol: number,
  label: string,
) {
  const curve = new PiecewiseLinearProperty(table);
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const T = lo + ((hi - lo) * i) / 2000;
    worst = Math.max(worst, Math.abs(curve.value(T) - fit(T)) / fit(T));
  }
  console.log(
    `${label}: table-vs-fit worst relative deviation ${(worst * 100).toFixed(3)} % (${table.length} knots)`,
  );
  expect(worst).toBeLessThan(tol);
}

function expectClamps(curve: PiecewiseLinearProperty, lo: number, hi: number) {
  expect(curve.value(lo / 2)).toBe(curve.value(lo));
  expect(curve.value(hi * 1.5)).toBe(curve.value(hi));
  expect(curve.slope(lo / 2)).toBe(0);
  expect(curve.slope(hi * 1.5)).toBe(0);
}

describe("Aluminum 6061-T6 preset — NIST cryogenic fits (4–300 K)", () => {
  const cp = new PiecewiseLinearProperty(
    getSolidMaterialTable("aluminum-6061-t6", "cp"),
  );
  const k = new PiecewiseLinearProperty(
    getSolidMaterialTable("aluminum-6061-t6", "k"),
  );

  it("tables reproduce the NIST fits to ≤0.2 % over 4–300 K", () => {
    expectTableMatchesFit(
      getSolidMaterialTable("aluminum-6061-t6", "cp"),
      nistAl6061CpFit,
      4,
      300,
      0.002,
      "6061 cp",
    );
    expectTableMatchesFit(
      getSolidMaterialTable("aluminum-6061-t6", "k"),
      nistAl6061KFit,
      4,
      300,
      0.002,
      "6061 k",
    );
  });

  it("fit-value snapshot (drift sentinel)", () => {
    // Deterministic arithmetic pinned 2026-08-16 from the NIST page coefficients.
    expect(nistAl6061CpFit(300)).toBeCloseTo(953.8644, 3);
    expect(nistAl6061CpFit(77)).toBeCloseTo(348.1279, 3);
    expect(nistAl6061CpFit(4)).toBeCloseTo(0.292, 3);
    expect(nistAl6061KFit(300)).toBeCloseTo(155.3188, 3);
    expect(nistAl6061KFit(20)).toBeCloseTo(28.4275, 3);
  });

  it("room-temperature anchors vs canonical handbook values (within NIST stated accuracy)", () => {
    // 6061-T6 at ~300 K: cp ≈ 896–960 J/(kg·K), k ≈ 150–167 W/(m·K).
    expect(Math.abs(cp.value(300) - 900) / 900).toBeLessThan(0.1);
    expect(Math.abs(k.value(300) - 155) / 155).toBeLessThan(0.08);
  });

  it("clamps outside 4–300 K; provenance records the range", () => {
    expectClamps(cp, 4, 300);
    expectClamps(k, 4, 300);
    const m = SOLID_MATERIALS["aluminum-6061-t6"];
    expect(m.provenance.validityRangeK).toEqual([4, 300]);
    expect(m.provenance.source).toContain("NIST");
    expect(m.provenance.url).toContain("6061");
  });
});

describe("Stainless steel 304/316 composites — NIST cryogenic + ANL-75-55 high-T", () => {
  const cases = [
    {
      name: "stainless-steel-304" as const,
      nistCp: nistSs304CpFit,
      nistK: nistSs304KFit,
      anlCp: anl304LCpFit,
      anlK: anl304LKFit,
      // ANL-75-55 Table 2 / Table 10 printed values at 1000 K, converted to SI:
      anlCp1000: 0.1444 * 4184, // cal/(g·K) → J/(kg·K)
      anlK1000: 0.2429 * 100, // W/(cm·K) → W/(m·K)
    },
    {
      name: "stainless-steel-316" as const,
      nistCp: nistSs316CpFit,
      nistK: nistSs316KFit,
      anlCp: anl316LCpFit,
      anlK: anl316LKFit,
      anlCp1000: 0.1414 * 4184,
      anlK1000: 0.2496 * 100,
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      const cp = new PiecewiseLinearProperty(
        getSolidMaterialTable(c.name, "cp"),
      );
      const k = new PiecewiseLinearProperty(getSolidMaterialTable(c.name, "k"));

      it("tables reproduce the NIST fits to ≤0.2 % over the cryogenic region (4–300 K)", () => {
        expectTableMatchesFit(
          getSolidMaterialTable(c.name, "cp"),
          c.nistCp,
          4,
          300,
          0.002,
          `${c.name} cp`,
        );
        expectTableMatchesFit(
          getSolidMaterialTable(c.name, "k"),
          c.nistK,
          4,
          300,
          0.002,
          `${c.name} k`,
        );
      });

      it("300 K splice preserves the NIST anchor exactly (no jump)", () => {
        // Table value AT 300 K is the NIST fit value (within table interp error)…
        expect(
          Math.abs(cp.value(300) - c.nistCp(300)) / c.nistCp(300),
        ).toBeLessThan(0.002);
        expect(
          Math.abs(k.value(300) - c.nistK(300)) / c.nistK(300),
        ).toBeLessThan(0.002);
        // …and the curve is continuous across the splice (no step).
        for (const T of [300, 500]) {
          const dCp =
            Math.abs(cp.value(T + 1e-3) - cp.value(T - 1e-3)) / cp.value(T);
          const dK =
            Math.abs(k.value(T + 1e-3) - k.value(T - 1e-3)) / k.value(T);
          expect(dCp).toBeLessThan(1e-3);
          expect(dK).toBeLessThan(1e-3);
        }
        // The two sources do NOT agree at 300 K (that is why the splice exists):
        // assert the offset is real and handled by blending, not a jump.
        expect(Math.abs(c.nistCp(300) / c.anlCp(300) - 1)).toBeGreaterThan(
          0.005,
        );
      });

      it("above 500 K the table is the pure ANL-75-55 correlation (≤0.2 % table error)", () => {
        expectTableMatchesFit(
          getSolidMaterialTable(c.name, "cp"),
          c.anlCp,
          500,
          1600,
          0.002,
          `${c.name} cp ANL`,
        );
        expectTableMatchesFit(
          getSolidMaterialTable(c.name, "k"),
          c.anlK,
          500,
          1600,
          0.002,
          `${c.name} k ANL`,
        );
      });

      it("matches the ANL-75-55 printed table anchors at 1000 K", () => {
        expect(
          Math.abs(cp.value(1000) - c.anlCp1000) / c.anlCp1000,
        ).toBeLessThan(0.005);
        expect(Math.abs(k.value(1000) - c.anlK1000) / c.anlK1000).toBeLessThan(
          0.005,
        );
      });

      it("cp and k increase monotonically over 300–1600 K (no blend artefact)", () => {
        for (let i = 0; i < 1300; i++) {
          const T = 300 + i;
          expect(cp.value(T + 1)).toBeGreaterThan(cp.value(T));
          expect(k.value(T + 1)).toBeGreaterThan(k.value(T));
        }
      });

      it("clamps outside 4–1600 K; provenance records the composite sources", () => {
        expectClamps(cp, 4, 1600);
        expectClamps(k, 4, 1600);
        const m = SOLID_MATERIALS[c.name];
        expect(m.provenance.validityRangeK).toEqual([4, 1600]);
        expect(m.provenance.source).toContain("NIST");
        expect(m.provenance.source).toContain("ANL-75-55");
        expect(m.provenance.notes).toContain("300 K");
      });
    });
  }

  it("NIST 316 two-fit cp join at 50 K is within 0.2 % (documented step)", () => {
    const lo = nistSs316CpFit(50 - 1e-9);
    const hi = nistSs316CpFit(50 + 1e-9);
    expect(Math.abs(hi / lo - 1)).toBeLessThan(0.002);
    // …and the sampled table is continuous there (single knot value).
    const cp = new PiecewiseLinearProperty(
      getSolidMaterialTable("stainless-steel-316", "cp"),
    );
    expect(
      Math.abs(cp.value(50.001) - cp.value(49.999)) / cp.value(50),
    ).toBeLessThan(0.002);
  });

  it("fit-value snapshot (drift sentinel)", () => {
    // Deterministic arithmetic pinned 2026-08-16 from the published coefficients.
    expect(nistSs304CpFit(300)).toBeCloseTo(469.4488, 3);
    expect(nistSs304KFit(300)).toBeCloseTo(15.3087, 3);
    expect(nistSs316CpFit(300)).toBeCloseTo(490.2134, 3);
    expect(nistSs316CpFit(4)).toBeCloseTo(1.9774, 3);
    expect(anl304LCpFit(300)).toBeCloseTo(509.887, 2);
    expect(anl304LKFit(300)).toBeCloseTo(12.97, 2);
    expect(anl316LCpFit(300)).toBeCloseTo(498.825, 2);
    expect(anl316LKFit(300)).toBeCloseTo(13.961, 2);
  });
});

describe("Inconel 718 preset — Agazhanov et al. 2019 (CC-BY), 298–1375 K", () => {
  const cp = new PiecewiseLinearProperty(
    getSolidMaterialTable("inconel-718", "cp"),
  );
  const k = new PiecewiseLinearProperty(
    getSolidMaterialTable("inconel-718", "k"),
  );

  // Recommended values from the source paper's Table 2 (cp converted
  // J/(g·K) → J/(kg·K)); tolerances cover the table's 4-digit print rounding
  // (measured deviations ≤0.08 %).
  const CP_ANCHORS_IN718: Array<[number, number]> = [
    [298, 425],
    [400, 447],
    [500, 468],
    [600, 489],
    [700, 510],
    [800, 531],
    [1100, 635],
    [1200, 635],
    [1300, 635],
  ];
  const K_ANCHORS_IN718: Array<[number, number]> = [
    [298, 9.94],
    [400, 11.59],
    [500, 13.24],
    [600, 14.91],
    [700, 16.61],
    [800, 18.34],
    [1200, 23.61],
    [1300, 24.47],
  ];

  it.each(CP_ANCHORS_IN718)(
    "cp(%d K) matches the paper Table 2 recommended value",
    (T, ref) => {
      expect(Math.abs(cp.value(T) - ref)).toBeLessThan(0.01 * ref);
    },
  );

  it.each(K_ANCHORS_IN718)(
    "k(%d K) matches the paper Table 2 recommended value",
    (T, ref) => {
      expect(Math.abs(k.value(T) - ref)).toBeLessThan(0.01 * ref);
    },
  );

  it("tables reproduce the piecewise source curve to ≤0.2 % over 298–1375 K", () => {
    expectTableMatchesFit(
      getSolidMaterialTable("inconel-718", "cp"),
      inconel718CpFit,
      298,
      1375,
      0.002,
      "IN718 cp",
    );
    expectTableMatchesFit(
      getSolidMaterialTable("inconel-718", "k"),
      inconel718KFit,
      298,
      1375,
      0.002,
      "IN718 k",
    );
  });

  it("is continuous at the branch points and across the documented transformation gaps", () => {
    // cp branch equality at 800 K is by construction of the published equations.
    expect(inconel718CpFit(800 - 1e-9)).toBeCloseTo(
      inconel718CpFit(800 + 1e-9),
      6,
    );
    for (const T of [800, INCONEL718_GAP_CP_K[0], INCONEL718_GAP_CP_K[1]]) {
      expect(
        Math.abs(cp.value(T + 0.01) - cp.value(T - 0.01)) / cp.value(T),
      ).toBeLessThan(1e-3);
    }
    for (const T of [INCONEL718_GAP_K_K[0], INCONEL718_GAP_K_K[1]]) {
      expect(
        Math.abs(k.value(T + 0.01) - k.value(T - 0.01)) / k.value(T),
      ).toBeLessThan(1e-3);
    }
    expect(INCONEL718_GAP_CP_K).toEqual([900, 1070]);
    expect(INCONEL718_GAP_K_K).toEqual([800, 1173]);
  });

  it("clamps below 298 K and above 1375 K; provenance records source and gap", () => {
    expectClamps(cp, 298, 1375);
    expectClamps(k, 298, 1375);
    expect(cp.value(250)).toBeCloseTo(425.116, 2); // 298 K value
    const m = SOLID_MATERIALS["inconel-718"];
    expect(m.provenance.validityRangeK).toEqual([298, 1375]);
    expect(m.provenance.source).toContain("Agazhanov");
    expect(m.provenance.url).toContain("10.1088/1742-6596/1382/1/012175");
    expect(m.provenance.notes).toContain("900–1070");
    expect(m.provenance.notes).toContain("800–1173");
  });
});

describe("GRCop-84 preset — Ellis NASA/CR-2000-210055, 296–1173 K", () => {
  const cp = new PiecewiseLinearProperty(
    getSolidMaterialTable("grcop-84", "cp"),
  );
  const k = new PiecewiseLinearProperty(getSolidMaterialTable("grcop-84", "k"));

  it("tables reproduce the source fits to ≤0.2 % over 296–1173 K", () => {
    expectTableMatchesFit(
      getSolidMaterialTable("grcop-84", "cp"),
      grcop84CpFit,
      GRCOP84_TMIN,
      GRCOP84_TMAX,
      0.002,
      "GRCop-84 cp",
    );
    expectTableMatchesFit(
      getSolidMaterialTable("grcop-84", "k"),
      grcop84KFit,
      GRCOP84_TMIN,
      GRCOP84_TMAX,
      0.002,
      "GRCop-84 k",
    );
  });

  it("fit-value snapshot (drift sentinel)", () => {
    // Deterministic arithmetic pinned from Ellis NASA/CR-2000-210055 eqs. 12 and 17.
    expect(grcop84CpFit(296)).toBeCloseTo(381.291, 2);
    expect(grcop84CpFit(600)).toBeCloseTo(419.879, 2);
    expect(grcop84KFit(550)).toBeCloseTo(304.921, 2);
    expect(grcop84KFit(296)).toBeCloseTo(284.305, 2);
  });

  it("k over MCC liner temperatures sits in the Ellis TM-2005 305–320 W/m·K band", () => {
    // NASA/TM-2005-213566 quotes 305–320 W/m·K for MCC liners.  The regression
    // mean at the regen seed wall (550 K) is the low end of that band; it is
    // not the old constant-320 stand-in.
    for (const T of [500, 550, 600, 700]) {
      expect(grcop84KFit(T)).toBeGreaterThan(280);
      expect(grcop84KFit(T)).toBeLessThan(330);
    }
    expect(grcop84KFit(550)).toBeGreaterThan(300);
    expect(grcop84KFit(550)).toBeLessThan(320);
  });

  it("clamps below 296 K and above 1173 K; provenance records source and alloy", () => {
    expectClamps(cp, GRCOP84_TMIN, GRCOP84_TMAX);
    expectClamps(k, GRCOP84_TMIN, GRCOP84_TMAX);
    expect(cp.value(250)).toBe(cp.value(GRCOP84_TMIN));
    const m = SOLID_MATERIALS["grcop-84"];
    expect(m.provenance.validityRangeK).toEqual([GRCOP84_TMIN, GRCOP84_TMAX]);
    expect(m.provenance.source).toContain("NASA/CR-2000-210055");
    expect(m.provenance.url).toContain("20000064095");
    expect(m.provenance.notes).toContain("Cu-8 at.% Cr-4 at.% Nb");
    expect(m.provenance.notes).toContain("not C18150");
    expect(m.provenance.statedFitAccuracy).toContain("regression mean");
  });
});

describe("PTFE and G-10 CR presets — NIST cryogenic fits", () => {
  it("PTFE tables reproduce the NIST fits to ≤0.2 % over 4–300 K", () => {
    expectTableMatchesFit(
      getSolidMaterialTable("ptfe", "cp"),
      nistPtfeCpFit,
      4,
      300,
      0.002,
      "PTFE cp",
    );
    expectTableMatchesFit(
      getSolidMaterialTable("ptfe", "k"),
      nistPtfeKFit,
      4,
      300,
      0.002,
      "PTFE k",
    );
  });

  it("G-10 tables reproduce the NIST fits (cp shared; k per direction)", () => {
    expectTableMatchesFit(
      getSolidMaterialTable("g10-cr-normal", "cp"),
      nistG10CpFit,
      4,
      300,
      0.002,
      "G10 cp",
    );
    expectTableMatchesFit(
      getSolidMaterialTable("g10-cr-warp", "cp"),
      nistG10CpFit,
      4,
      300,
      0.002,
      "G10 cp (warp entry)",
    );
    expectTableMatchesFit(
      getSolidMaterialTable("g10-cr-normal", "k"),
      nistG10KNormalFit,
      10,
      300,
      0.002,
      "G10 k normal",
    );
    expectTableMatchesFit(
      getSolidMaterialTable("g10-cr-warp", "k"),
      nistG10KWarpFit,
      12,
      300,
      0.002,
      "G10 k warp",
    );
  });

  it("fit-value snapshot (drift sentinel)", () => {
    // Deterministic arithmetic pinned 2026-08-16 from the NIST page coefficients.
    expect(nistPtfeCpFit(300)).toBeCloseTo(1031.705, 2);
    expect(nistPtfeKFit(300)).toBeCloseTo(0.272802, 4);
    expect(nistPtfeCpFit(20)).toBeCloseTo(76.7918, 2);
    expect(nistG10CpFit(300)).toBeCloseTo(998.7427, 2);
    expect(nistG10KNormalFit(300)).toBeCloseTo(0.607983, 4);
    expect(nistG10KWarpFit(300)).toBeCloseTo(0.863638, 4);
  });

  it("room-temperature anchors vs canonical values (within NIST stated accuracy)", () => {
    const ptfeCp = new PiecewiseLinearProperty(
      getSolidMaterialTable("ptfe", "cp"),
    );
    const ptfeK = new PiecewiseLinearProperty(
      getSolidMaterialTable("ptfe", "k"),
    );
    // PTFE at ~300 K: cp ≈ 1000–1050 J/(kg·K), k ≈ 0.25–0.30 W/(m·K).
    expect(Math.abs(ptfeCp.value(300) - 1025) / 1025).toBeLessThan(0.05);
    expect(Math.abs(ptfeK.value(300) - 0.27) / 0.27).toBeLessThan(0.1);
  });

  it("G-10 k anisotropy: warp > normal, and the k ranges honour the equation ranges", () => {
    const kN = new PiecewiseLinearProperty(
      getSolidMaterialTable("g10-cr-normal", "k"),
    );
    const kW = new PiecewiseLinearProperty(
      getSolidMaterialTable("g10-cr-warp", "k"),
    );
    expect(kN.minT).toBe(10); // NIST equation range starts at 10 K (normal)
    expect(kW.minT).toBe(12); // …and at 12 K (warp)
    for (const T of [20, 77, 300]) {
      expect(kW.value(T)).toBeGreaterThan(kN.value(T));
    }
    // Clamps below the equation range and above 300 K.
    expect(kN.value(4)).toBe(kN.value(10));
    expect(kW.value(4)).toBe(kW.value(12));
    expect(kN.value(400)).toBe(kN.value(300));
    expect(kW.value(400)).toBe(kW.value(300));
  });

  it("provenance: anisotropy labels and ranges", () => {
    const n = SOLID_MATERIALS["g10-cr-normal"];
    const w = SOLID_MATERIALS["g10-cr-warp"];
    expect(n.provenance.source).toContain("NORMAL");
    expect(w.provenance.source).toContain("WARP");
    expect(n.provenance.validityRangeK).toEqual([10, 300]);
    expect(w.provenance.validityRangeK).toEqual([12, 300]);
    expect(SOLID_MATERIALS["ptfe"].provenance.validityRangeK).toEqual([4, 300]);
  });
});

describe("registry-wide invariants", () => {
  it("every material has provenance, positive tables, and a validity range matching its table extents", () => {
    for (const [name, m] of Object.entries(SOLID_MATERIALS)) {
      const p = m.provenance;
      expect(p.source.length, name).toBeGreaterThan(0);
      expect(p.url, name).toMatch(/^https?:\/\//);
      expect(p.fitForm.length, name).toBeGreaterThan(0);
      expect(p.statedFitAccuracy.length, name).toBeGreaterThan(0);
      expect(p.notes.length, name).toBeGreaterThan(0);
      const cp = new PiecewiseLinearProperty(m.cpTable);
      const k = m.kTable ? new PiecewiseLinearProperty(m.kTable) : undefined;
      // validityRangeK is the intersection of the supported property ranges.
      const lo = Math.max(cp.minT, k ? k.minT : -Infinity);
      const hi = Math.min(cp.maxT, k ? k.maxT : Infinity);
      expect(p.validityRangeK, name).toEqual([lo, hi]);
      // All knots strictly increasing with positive values.
      for (const table of [m.cpTable, ...(m.kTable ? [m.kTable] : [])]) {
        for (let i = 0; i < table.length; i++) {
          expect(table[i][1], `${name} knot ${i}`).toBeGreaterThan(0);
          if (i > 0)
            expect(table[i][0], `${name} knot ${i}`).toBeGreaterThan(
              table[i - 1][0],
            );
        }
      }
    }
  });

  it("catalogue breadth: at least two materials are valid above 1000 K", () => {
    const wide = Object.values(SOLID_MATERIALS).filter(
      (m) => m.provenance.validityRangeK[1] > 1000,
    );
    expect(wide.length).toBeGreaterThanOrEqual(2);
  });
});

describe("PiecewiseLinearProperty mechanics", () => {
  const tri = new PiecewiseLinearProperty([
    [10, 100],
    [20, 300],
    [50, 600],
  ]);

  it("interpolates exactly at knots and linearly between", () => {
    expect(tri.value(10)).toBe(100);
    expect(tri.value(20)).toBe(300);
    expect(tri.value(15)).toBeCloseTo(200, 12);
    expect(tri.value(35)).toBeCloseTo(450, 12);
  });

  it("clamps outside the knot range (value = endpoint, slope = 0)", () => {
    expect(tri.value(5)).toBe(100);
    expect(tri.value(80)).toBe(600);
    expect(tri.slope(5)).toBe(0);
    expect(tri.slope(80)).toBe(0);
    expect(tri.slope(15)).toBeCloseTo(20, 12);
  });

  it("integral is the exact piecewise quadratic of the interpolant", () => {
    // ∫_10^20 of (100 + 20·(T−10)) dT = 100·10 + 10·100 = 2000
    expect(tri.integral(20)).toBeCloseTo(2000, 10);
    // ∫_20^35 of (300 + 10·(T−20)) dT = 300·15 + 5·225 = 5625
    expect(tri.integral(35)).toBeCloseTo(2000 + 5625, 8);
    // Below minT: linear extension with clamped value: −100·5 from T=5
    expect(tri.integral(5)).toBeCloseTo(-500, 10);
    // Above maxT: cumInt(50) + 600·30
    expect(tri.integral(80)).toBeCloseTo(tri.integral(50) + 18000, 6);
  });

  it("d(integral)/dT == value (FD consistency, mid-segment)", () => {
    for (const T of [12.3, 27.7, 44.1]) {
      const d = 1e-4;
      const fd = (tri.integral(T + d) - tri.integral(T - d)) / (2 * d);
      expect(Math.abs(fd - tri.value(T)) / tri.value(T)).toBeLessThan(1e-9);
    }
  });

  it("constant-valued table behaves as the constant property (enthalpy linear in T)", () => {
    const flat = new PiecewiseLinearProperty([
      [4, 385],
      [300, 385],
    ]);
    expect(flat.integral(200)).toBeCloseTo(385 * (200 - 4), 10);
    expect(flat.value(123.4)).toBe(385);
  });
});

describe("spec resolution & validation", () => {
  it("resolveSolidProperty returns a number for constants (legacy path)", () => {
    expect(resolveSolidProperty(385, "cp", "test")).toBe(385);
  });

  it("resolveSolidProperty builds curves for tables and materials", () => {
    const c1 = resolveSolidProperty(
      {
        table: [
          [10, 100],
          [20, 300],
        ],
      },
      "cp",
      "test",
    );
    expect(c1).toBeInstanceOf(PiecewiseLinearProperty);
    const c2 = resolveSolidProperty({ material: "ofhc-copper" }, "cp", "test");
    expect(c2).toBeInstanceOf(PiecewiseLinearProperty);
    expect((c2 as PiecewiseLinearProperty).value(77)).toBeCloseTo(195.9209, 0);
  });

  it("throws on malformed specs (solver-side defense; validate.ts reports them first)", () => {
    expect(() =>
      resolveSolidProperty({ table: [[10, 100]] }, "cp", "nodeX"),
    ).toThrow(/at least 2/);
    expect(() =>
      resolveSolidProperty(
        {
          table: [
            [20, 100],
            [10, 300],
          ],
        },
        "cp",
        "nodeX",
      ),
    ).toThrow(/strictly increasing/);
    expect(() =>
      resolveSolidProperty(
        {
          table: [
            [10, -5],
            [20, 300],
          ],
        },
        "cp",
        "nodeX",
      ),
    ).toThrow(/positive/);
    expect(() =>
      resolveSolidProperty({ material: "unobtanium" }, "cp", "nodeX"),
    ).toThrow(/unobtanium/);
  });

  it("validateSolidPropertySpec messages name the owner", () => {
    expect(validateSolidPropertySpec(385, "cp", "Solid node s1")).toEqual([]);
    expect(validateSolidPropertySpec(-3, "cp", "Solid node s1")[0]).toContain(
      "s1",
    );
    expect(
      validateSolidPropertySpec(undefined, "cp", "Solid node s1")[0],
    ).toContain("required");
    expect(
      validateSolidPropertySpec(
        { material: "ofhc-copper" },
        "cp",
        "Solid node s1",
      ),
    ).toEqual([]);
    expect(
      validateSolidPropertySpec({ material: "nope" }, "k", "Conductor c1")[0],
    ).toContain("nope");
  });
});

describe("validateNetwork integration", () => {
  const base: NetworkConfig = {
    meta: { name: "val", version: 2 },
    settings: {
      mode: "transient",
      dt: 1,
      endTime: 2,
      tolerance: 1e-6,
      maxIterations: 50,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "f1",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
      {
        id: "f2",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "b",
        from: "f1",
        to: "f2",
        component: { type: "flowSource", massFlow: 0 },
      },
    ],
  };

  it("accepts table and material cp; rejects bad tables; legacy messages unchanged", () => {
    const ok: NetworkConfig = {
      ...base,
      solidNodes: [
        {
          id: "s1",
          type: "solid",
          x: 0,
          y: 5,
          temperature: 300,
          mass: 1,
          cp: { material: "ofhc-copper" },
        },
        {
          id: "s2",
          type: "solid",
          x: 1,
          y: 5,
          temperature: 300,
          mass: 1,
          cp: {
            table: [
              [77, 190],
              [300, 385],
            ],
          },
        },
      ],
      conductors: [
        {
          id: "c1",
          from: "s1",
          to: "s2",
          type: {
            kind: "conduction",
            k: { material: "ofhc-copper" },
            area: 0.01,
            length: 0.1,
          },
        },
      ],
    };
    expect(validateNetwork(ok)).toEqual([]);

    const badTable: NetworkConfig = {
      ...base,
      solidNodes: [
        {
          id: "s1",
          type: "solid",
          x: 0,
          y: 5,
          temperature: 300,
          mass: 1,
          cp: {
            table: [
              [300, 385],
              [77, 190],
            ],
          },
        },
      ],
    };
    expect(
      validateNetwork(badTable).some((e) => e.includes("strictly increasing")),
    ).toBe(true);

    const legacy: NetworkConfig = {
      ...base,
      solidNodes: [
        {
          id: "s1",
          type: "solid",
          x: 0,
          y: 5,
          temperature: 300,
          mass: 1,
          cp: -5,
        },
      ],
    };
    expect(
      validateNetwork(legacy).some((e) =>
        e.includes("must have positive cp in transient mode"),
      ),
    ).toBe(true);

    const badK: NetworkConfig = {
      ...base,
      solidNodes: [
        {
          id: "s1",
          type: "solid",
          x: 0,
          y: 5,
          temperature: 300,
          mass: 1,
          cp: 385,
        },
        {
          id: "s2",
          type: "solid",
          x: 1,
          y: 5,
          temperature: 300,
          mass: 1,
          cp: 385,
        },
      ],
      conductors: [
        {
          id: "c1",
          from: "s1",
          to: "s2",
          type: {
            kind: "conduction",
            k: { material: "nope" },
            area: 0.01,
            length: 0.1,
          },
        },
      ],
    };
    expect(
      validateNetwork(badK).some((e) => e.includes("nope") && e.includes("c1")),
    ).toBe(true);
  });
});
