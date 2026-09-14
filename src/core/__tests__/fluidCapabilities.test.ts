/**
 * Every fluid model declares what the solver may assume about it, so the
 * solver's formulation decisions (energy unknown, dome possible) dispatch on
 * the declaration rather than on the class.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  IncompressibleLiquid,
  IdealGas,
  ExpandableLiquid,
  ANALYTIC_FLUID_CAPABILITIES,
  type FluidModel,
} from "../fluids";
import { RealFluid } from "../fluids/realFluid";
import { initRealFluids } from "../fluids/coolprop";

describe("FluidCapabilities", () => {
  beforeAll(async () => {
    await initRealFluids();
  }, 30000);

  it("analytic closures carry T as the state and never flash", () => {
    const models: FluidModel[] = [
      new IncompressibleLiquid(1000, 1e-3, 4180),
      new IdealGas(287, 1.4, 1.8e-5, 1005),
      new ExpandableLiquid(1000, 4.5e-10, 293, 1e-3, 4180),
    ];
    for (const m of models) {
      expect(m.capabilities).toEqual(ANALYTIC_FLUID_CAPABILITIES);
    }
  });

  it("the CoolProp-backed model declares an enthalpy state with a dome", () => {
    const n2: FluidModel = new RealFluid("Nitrogen");
    expect(n2.capabilities).toEqual({ twoPhase: true, enthalpyState: true });
  });
});
