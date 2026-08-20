/**
 * SINDA/FLUINT Sample Problem F — no-vent fill of an LH2 storage tank.
 *
 * The example emulates FLUINT's twinned tanks and moveable ties with
 * registers, logic rules and register controllers (see src/ui/lh2StorageTank.ts
 * for what is emulated versus matched).  These tests pin the emulation against
 * the deck's own 15-minute fill results, and guard the two numerical
 * properties that the emulation depends on and that silently broke it during
 * development: the tank volume constraint must hold exactly, and the ullage
 * must not oscillate step to step.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initRealFluids, solveTransient, validateNetwork } from "../../core";
import { lh2StorageTankNoVentFill } from "../examples";

const PSI = 6894.757293168;
const RANK = 5 / 9; // degrees Rankine -> Kelvin
const LBM_HR = 0.45359237 / 3600;

beforeAll(async () => {
  await initRealFluids();
}, 30000);

/** Deck Figure F-4 / user-file table, 15 min into the fill. */
const DECK = {
  fillFraction: 0.739,
  pressure: 59.721 * PSI,
  vaporTemp: 47.387 * RANK,
  liquidTemp: 38.098 * RANK,
  tvsFlow: 0.0522 * LBM_HR,
};

describe("SINDA/FLUINT Sample F: LH2 tank no-vent fill", () => {
  const result = (() => {
    let cached: ReturnType<typeof solveTransient> | undefined;
    return () => (cached ??= solveTransient(lh2StorageTankNoVentFill));
  })();

  it("validates with zero errors", () => {
    expect(validateNetwork(lh2StorageTankNoVentFill)).toEqual([]);
  });

  it("converges over the 15 min fill", { timeout: 60000 }, () => {
    const r = result();
    expect(r.converged).toBe(true);
    expect(r.times[r.times.length - 1]).toBeCloseTo(900, 6);
  });

  it("matches the deck fill table at 15 min", { timeout: 60000 }, () => {
    const g = result().finalRegisters!;
    expect(g.fillFrac / DECK.fillFraction).toBeCloseTo(1, 1);
    expect(g.Ptank / DECK.pressure).toBeCloseTo(1, 2);
    expect(g.TV / DECK.vaporTemp).toBeCloseTo(1, 1);
    expect(g.TL / DECK.liquidTemp).toBeCloseTo(1, 1);
    expect(g.mdotTvs / DECK.tvsFlow).toBeCloseTo(1, 1);
  });

  it(
    "raises tank pressure toward the source rather than collapsing it",
    { timeout: 60000 },
    () => {
      // The point of the twinned-tank emulation: an equilibrium tank fed
      // subcooled liquid would condense its ullage and LOSE pressure.
      const P = result().nodes["tankVap"].pressure;
      expect(P[P.length - 1]).toBeGreaterThan(P[0]);
      for (let i = 1; i < P.length; i++)
        expect(P[i]).toBeGreaterThanOrEqual(P[i - 1] * 0.999);
    },
  );

  it("holds the tank volume constraint exactly", { timeout: 60000 }, () => {
    const g = result().finalRegisters!;
    expect(Math.abs(g.VL + g.VV - g.V_tank) / g.V_tank).toBeLessThan(1e-9);
    // ...and the pressure relaxation has driven the density-derived ullage
    // volume onto the constrained one.
    expect(Math.abs(g.VVrho - g.VV) / g.VV).toBeLessThan(0.05);
  });

  it(
    "keeps the ullage free of step-to-step oscillation",
    { timeout: 60000 },
    () => {
      // The vapor volume used to come from mV/rhoV, which closes a lagged loop
      // through the vapor's own temperature and locks into a period-2 limit
      // cycle of several kelvin.  Successive differences must not alternate in
      // sign over a long run.
      const TV = result().nodes["tankVap"].temperature;
      let alternations = 0;
      for (let i = 2; i < TV.length; i++) {
        const a = TV[i] - TV[i - 1];
        const b = TV[i - 1] - TV[i - 2];
        if (a * b < 0) alternations++;
      }
      expect(alternations / TV.length).toBeLessThan(0.1);
    },
  );

  it(
    "superheats the ullage without letting it run away",
    { timeout: 60000 },
    () => {
      // Free vapor temperature is what produces the deck's pressure rise, but
      // the condensing wall film has to bound the superheat: the deck ends the
      // fill within ~1 R of saturation.
      const g = result().finalRegisters!;
      expect(g.TV).toBeGreaterThanOrEqual(g.Tsat);
      expect(g.TV - g.Tsat).toBeLessThan(2);
    },
  );
});
