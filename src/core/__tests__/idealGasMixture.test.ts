import { describe, it, expect } from "vitest";
import { IdealGasMixture } from "../fluids";

describe("IdealGasMixture", () => {
  // Air-like mixture: 0.767 N2 / 0.233 O2 by mass
  const names = ["N2", "O2"];
  const mw = [0.0280134, 0.0319988];
  const cp = [1040, 920];
  const air = new IdealGasMixture(names, mw, cp);

  it("mixture molecular weight of air ≈ 28.85 g/mol", () => {
    const Y = { N2: 0.767, O2: 0.233 };
    const W = air.W_mix(Y);
    expect(W).toBeCloseTo(0.02885, 4);
  });

  it("mixture R of air ≈ 288 J/kgK", () => {
    const Y = { N2: 0.767, O2: 0.233 };
    const R = air.R_mix(Y);
    expect(R).toBeCloseTo(8.314462618 / 0.02885, 1);
  });

  it("densityMix matches ideal gas law", () => {
    const Y = { N2: 0.767, O2: 0.233 };
    const P = 101325;
    const T = 300;
    const rho = air.densityMix(P, T, Y);
    const R = air.R_mix(Y);
    expect(rho).toBeCloseTo(P / (R * T), 6);
  });

  it("cpMix is mass-weighted average", () => {
    const Y = { N2: 0.767, O2: 0.233 };
    const cpMix = air.cpMix(1e5, 300, Y);
    const expected = 0.767 * 1040 + 0.233 * 920;
    expect(cpMix).toBeCloseTo(expected, 6);
  });

  it("enthalpyMix is cp-weighted with formation enthalpy", () => {
    const hForm = [0, 2e6]; // O2 has formation enthalpy
    const gas = new IdealGasMixture(names, mw, cp, hForm);
    const Y = { N2: 0.5, O2: 0.5 };
    const T = 300;
    const h = gas.enthalpyMix(1e5, T, Y);
    const expected = 0.5 * (1040 * 300 + 0) + 0.5 * (920 * 300 + 2e6);
    expect(h).toBeCloseTo(expected, 6);
  });

  it("pure-species limit reduces to single-species value", () => {
    const pureN2 = { N2: 1.0, O2: 0.0 };
    expect(air.cpMix(1e5, 300, pureN2)).toBeCloseTo(1040, 6);
    expect(air.densityMix(1e5, 300, pureN2)).toBeCloseTo(
      1e5 / ((8.314462618 / 0.0280134) * 300),
      6,
    );

    const pureO2 = { N2: 0.0, O2: 1.0 };
    expect(air.cpMix(1e5, 300, pureO2)).toBeCloseTo(920, 6);
    expect(air.densityMix(1e5, 300, pureO2)).toBeCloseTo(
      1e5 / ((8.314462618 / 0.0319988) * 300),
      6,
    );
  });

  it("switching node from N2 to He at fixed P,T changes density by MW ratio", () => {
    const heavy = new IdealGasMixture(["N2"], [0.028], [1040]);
    const light = new IdealGasMixture(["He"], [0.004], [5193]);
    const P = 1e5;
    const T = 300;
    const rhoHeavy = heavy.densityMix(P, T, { N2: 1 });
    const rhoLight = light.densityMix(P, T, { He: 1 });
    expect(rhoHeavy / rhoLight).toBeCloseTo(0.028 / 0.004, 3);
  });
});
