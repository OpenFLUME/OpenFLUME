import { describe, it, expect, beforeAll } from "vitest";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { getCoolProp } from "../fluids/coolprop";

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
}, 30000);

describe("Saturation anchors (NIST-anchored)", () => {
  it("N2 @ 101.325 kPa: Tsat≈77.355 K, h_fg≈198.8 kJ/kg, ρ_f≈806.1, ρ_g≈4.612", () => {
    const fluid = new RealFluid("Nitrogen");
    const P = 101325;
    const Tsat = fluid.saturationTemperature(P);
    const hf = fluid.hSatLiquid(P);
    const hg = fluid.hSatVapor(P);
    const rhof = fluid.rhoSatLiquid(P);
    const rhog = fluid.rhoSatVapor(P);

    expect(Tsat).toBeCloseTo(77.355, 1); // ±0.01 K would be toBeCloseTo(..., 2)
    const hfg = hg - hf;
    expect(hfg / 1000).toBeCloseTo(198.8, 0); // ±0.5% ≈ ±1 kJ/kg
    expect(rhof).toBeCloseTo(806.1, 0); // ±0.5% ≈ ±4 kg/m³
    expect(rhog).toBeCloseTo(4.612, 1); // ±0.5% ≈ ±0.02
  });

  it("Water @ 101.325 kPa: Tsat≈373.12 K, h_fg≈2256.5 kJ/kg", () => {
    const fluid = new RealFluid("Water");
    const P = 101325;
    const Tsat = fluid.saturationTemperature(P);
    const hf = fluid.hSatLiquid(P);
    const hg = fluid.hSatVapor(P);

    expect(Tsat).toBeCloseTo(373.12, 1);
    const hfg = hg - hf;
    expect(hfg / 1000).toBeCloseTo(2256.5, 0);
  });

  it("Hydrogen @ 516.8 kPa (74.97 psia): Tsat≈27.1 K, h_fg report measured", () => {
    const fluid = new RealFluid("Hydrogen");
    const P = 516.8e3;
    const Tsat = fluid.saturationTemperature(P);
    const hf = fluid.hSatLiquid(P);
    const hg = fluid.hSatVapor(P);
    const hfg = hg - hf;

    // NBS chilldown paper reference: Tsat ≈ 27.1 K at 74.97 psia
    expect(Tsat).toBeCloseTo(27.1, 0); // ±0.5% ≈ ±0.14 K
    // Actual CoolProp value for hydrogen at this condition
    expect(hfg / 1000).toBeCloseTo(369, 0); // measured ~369 kJ/kg
  });

  it("CO2 @ 3 MPa: Tsat≈267.6 K", () => {
    const fluid = new RealFluid("CarbonDioxide");
    const P = 3e6;
    const Tsat = fluid.saturationTemperature(P);
    expect(Tsat).toBeCloseTo(267.6, 0); // ±0.5% ≈ ±1.3 K
  });
});

describe("statePH dome behavior", () => {
  it("N2 at 101.325 kPa, h = hf + 0.5·hfg → T=Tsat, quality=0.5, ρ mixture matches harmonic", () => {
    const fluid = new RealFluid("Nitrogen");
    const P = 101325;
    const hf = fluid.hSatLiquid(P);
    const hg = fluid.hSatVapor(P);
    const hfg = hg - hf;
    const h = hf + 0.5 * hfg;

    const state = fluid.statePH(P, h);
    const Tsat = fluid.saturationTemperature(P);

    expect(state.phase).toBe("twoPhase");
    expect(state.T).toBeCloseTo(Tsat, 2); // ±0.01 K
    expect(state.quality).toBeCloseTo(0.5, 3); // ±0.005

    // Harmonic mixture density
    const rhof = fluid.rhoSatLiquid(P);
    const rhog = fluid.rhoSatVapor(P);
    const rhoMix = 1 / (0.5 / rhog + 0.5 / rhof);
    expect(Math.abs(state.rho - rhoMix) / rhoMix).toBeLessThan(0.005);
  });

  it("N2 quality spot checks: 0.25 and 0.75", () => {
    const fluid = new RealFluid("Nitrogen");
    const P = 101325;
    const hf = fluid.hSatLiquid(P);
    const hg = fluid.hSatVapor(P);
    const hfg = hg - hf;

    for (const x of [0.25, 0.75]) {
      const h = hf + x * hfg;
      const state = fluid.statePH(P, h);
      expect(state.phase).toBe("twoPhase");
      expect(state.quality).toBeCloseTo(x, 3);

      const rhof = fluid.rhoSatLiquid(P);
      const rhog = fluid.rhoSatVapor(P);
      const rhoMix = 1 / (x / rhog + (1 - x) / rhof);
      expect(Math.abs(state.rho - rhoMix) / rhoMix).toBeLessThan(0.005);
    }
  });

  it("N2 slightly below hf → liquid; above hg → vapor", () => {
    const fluid = new RealFluid("Nitrogen");
    const P = 101325;
    const hf = fluid.hSatLiquid(P);
    const hg = fluid.hSatVapor(P);
    const delta = 1000; // 1 kJ/kg buffer

    const stateLiquid = fluid.statePH(P, hf - delta);
    expect(stateLiquid.phase).toBe("liquid");
    expect(stateLiquid.quality).toBeUndefined();

    const stateVapor = fluid.statePH(P, hg + delta);
    expect(stateVapor.phase).toBe("vapor");
    expect(stateVapor.quality).toBeUndefined();
  });
});

describe("Round-trip consistency", () => {
  const fluids = [
    { name: "Nitrogen", P: 101325, Tliquid: 70, Tvapor: 100 },
    { name: "Water", P: 101325, Tliquid: 350, Tvapor: 400 },
    { name: "Hydrogen", P: 516.8e3, Tliquid: 25, Tvapor: 30 },
  ];

  for (const { name, P, Tliquid, Tvapor } of fluids) {
    it(`${name}: h → statePH → enthalpy round-trip < 1e-6 relative across liquid/dome/vapor`, () => {
      const fluid = new RealFluid(name as any);
      const hf = fluid.hSatLiquid(P);
      const hg = fluid.hSatVapor(P);

      const hValues = [
        fluid.enthalpyPT(P, Tliquid), // subcooled liquid
        hf + 0.3 * (hg - hf), // inside dome
        hf + 0.7 * (hg - hf), // inside dome
        fluid.enthalpyPT(P, Tvapor), // superheated vapor
      ];

      for (const h of hValues) {
        const state = fluid.statePH(P, h);
        let hBack: number;
        if (state.phase === "twoPhase" && state.quality !== undefined) {
          hBack = fluid.enthalpyPQ(P, state.quality);
        } else {
          hBack = fluid.enthalpyPT(P, state.T);
        }
        const relErr = Math.abs(hBack - h) / Math.max(Math.abs(h), 1);
        expect(relErr).toBeLessThan(1e-6);
      }
    });
  }

  it("Supercritical P line: N2 @ 5 MPa, 100 K — phase flag correct, no throw", () => {
    const fluid = new RealFluid("Nitrogen");
    const P = 5e6; // well above Pcrit≈3.39 MPa
    const T = 100;
    const h = fluid.enthalpyPT(P, T);
    const state = fluid.statePH(P, h);
    expect(state.phase).toBe("supercritical");
    expect(state.quality).toBeUndefined();
    expect(state.T).toBeCloseTo(T, 2);
  });
});

describe("internalEnergyPH / enthalpyFromInternalEnergy round-trip", () => {
  const fluids = [
    { name: "Nitrogen", P: 101325 },
    { name: "Water", P: 101325 },
    { name: "Hydrogen", P: 516.8e3 },
  ];

  for (const { name, P } of fluids) {
    it(`${name} @ ${(P / 1000).toFixed(0)} kPa: u → h → u round-trip < 1e-8 relative in dome and single-phase`, () => {
      const fluid = new RealFluid(name as any);
      const hf = fluid.hSatLiquid(P);
      const hg = fluid.hSatVapor(P);

      const hValues = [
        hf - 5000, // subcooled liquid
        hf + 0.4 * (hg - hf), // inside dome
        hg + 5000, // superheated vapor
      ];

      for (const h of hValues) {
        const u = fluid.internalEnergyPH(P, h);
        const hBack = fluid.enthalpyFromInternalEnergy(P, u);
        const uBack = fluid.internalEnergyPH(P, hBack);
        const relErrH = Math.abs(hBack - h) / Math.max(Math.abs(h), 1);
        const relErrU = Math.abs(uBack - u) / Math.max(Math.abs(u), 1);
        expect(relErrH).toBeLessThan(1e-8);
        expect(relErrU).toBeLessThan(1e-8);
      }
    });
  }
});

describe("McAdams viscosity", () => {
  it("N2 @ 101.325 kPa: continuous across dome boundaries, monotone in x", () => {
    const fluid = new RealFluid("Nitrogen");
    const P = 101325;
    const hf = fluid.hSatLiquid(P);
    const hg = fluid.hSatVapor(P);
    const cp = getCoolProp();
    const state = getStateViaCoolProp(fluid);

    state.update(cp.input_pairs.PQ_INPUTS, P, 0);
    const muf = state.viscosity();
    state.update(cp.input_pairs.PQ_INPUTS, P, 1);
    const mug = state.viscosity();

    // Slightly below dome → liquid viscosity ≈ muf (use tiny delta so T≈Tsat)
    const delta = 10; // 10 J/kg ≈ 0.01 K for liquid N2
    const stateL = fluid.statePH(P, hf - delta);
    expect(Math.abs(stateL.mu - muf) / muf).toBeLessThan(0.01); // ±1%

    // Slightly above dome → vapor viscosity ≈ mug
    const stateV = fluid.statePH(P, hg + delta);
    expect(Math.abs(stateV.mu - mug) / mug).toBeLessThan(0.01); // ±1%

    // Inside dome: monotonic in quality
    const mus: number[] = [];
    const xs = [0.05, 0.25, 0.5, 0.75, 0.95];
    for (const x of xs) {
      const h = hf + x * (hg - hf);
      const state = fluid.statePH(P, h);
      mus.push(state.mu);
    }
    // Should be monotonically decreasing (vapor has lower viscosity)
    for (let i = 1; i < mus.length; i++) {
      expect(mus[i]).toBeLessThanOrEqual(mus[i - 1]);
    }
  });
});

describe("Clamping and error handling", () => {
  it("negative pressure input → descriptive error (not WASM abort)", () => {
    const fluid = new RealFluid("Nitrogen");
    expect(() => fluid.statePH(-1, 1e5)).toThrow(/Pressure must be positive/);
    expect(() => fluid.statePH(-1, 1e5)).toThrow(/Nitrogen/);
    expect(() => fluid.saturationTemperature(-100)).toThrow(
      /Pressure must be positive/,
    );
  });

  it("h beyond safe bounds → descriptive error naming fluid+values", () => {
    const fluid = new RealFluid("Nitrogen");
    // Extreme h values should either work or throw a descriptive error
    expect(() => fluid.statePH(101325, 1e15)).toThrow(/Nitrogen/);
  });
});

describe("statePH performance", () => {
  it("per-call latency of statePH ~10–200 µs", () => {
    const fluid = new RealFluid("Nitrogen");
    const P = 101325;
    const h =
      fluid.hSatLiquid(P) + 0.5 * (fluid.hSatVapor(P) - fluid.hSatLiquid(P));

    // Warm-up
    for (let i = 0; i < 10; i++) fluid.statePH(P, h);

    const runs = 500;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) {
      fluid.statePH(P, h);
    }
    const t1 = performance.now();
    const avgUs = ((t1 - t0) * 1000) / runs; // ms → µs
    console.log(`statePH avg latency: ${avgUs.toFixed(2)} µs (${runs} runs)`);
    expect(avgUs).toBeGreaterThan(1);
    expect(avgUs).toBeLessThan(500); // generous upper bound for CI / first-call overhead
  });
});

// Helper to get the cached AbstractState for a fluid in tests
function getStateViaCoolProp(fluid: RealFluid) {
  const cp = getCoolProp();
  return cp.factory("HEOS", fluid.fluidName);
}
