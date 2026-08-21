/**
 * Regenerative cooling channel — LOX/RP-1 booster chamber.
 *
 * The example is a DESIGN POINT, not a benchmark: there is no published data to
 * match, so these tests pin the two things that can actually be checked.
 *
 *  1. CONSERVATION.  The coolant's enthalpy rise must equal the heat
 *     delivered by the T_aw reservoirs and conducted through the liner,
 *     and each cell's delivered flux must be h_eff·A·(T_aw − T_wg,solved).
 *
 *  2. THE DESIGN CLOSURE.  The jacket still has to pass the engine's fuel
 *     flow at the stated pump pressure — with the momentum-flux term ON —
 *     and the coolant must stay below the RP-1 coking limit.  The hot spot
 *     belongs at the skirt inlet.
 *
 *  3. THE HALF-SECTION LAYOUT.  The flat network view draws the chamber
 *     contour.
 *
 * See docs/regen-cooling-example.md for the derivation and the assumption
 * ledger, and src/ui/regenCoolingChannel.ts for the model itself.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  initRealFluids,
  solveSteady,
  validateNetwork,
  createFluidModel,
  isParameterExpression,
  previewNetworkParameters,
} from "../../core";
import type { SteadyResult } from "../../core";
import {
  mirandaRegenCoolingChannel,
  JACKET_CELLS,
  JACKET_DESIGN,
  buildRegenCoolingChannel,
  type JacketCell,
} from "../regenCoolingChannel";
import { normalizeCanvasLayout } from "../canvasLayout";
import {
  CANVAS_GRID_SIZE,
  FLUID_BOUNDARY_SIZE,
  FLUID_INTERNAL_SIZE,
  SOLID_NODE_SIZE,
  fluidNodeSize,
} from "../canvasGeometry";

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

beforeAll(async () => {
  await initRealFluids();
}, 30000);

/** Throat cell: smallest area ratio. Skirt inlet: last cell (coolant entrance). */
const THROAT_CELL = JACKET_CELLS.reduce((a, b) =>
  a.areaRatio <= b.areaRatio ? a : b,
).index;
const SKIRT_INLET_CELL = JACKET_CELLS[JACKET_CELLS.length - 1].index;

describe("RP-1 regenerative cooling channel", () => {
  const solve = (() => {
    let cached: SteadyResult | undefined;
    return () => (cached ??= solveSteady(mirandaRegenCoolingChannel));
  })();

  const mdotChannel = () => Math.abs(solve().branches["entrance"].mdot);

  it("validates with zero errors", () => {
    expect(validateNetwork(mirandaRegenCoolingChannel)).toEqual([]);
  });

  it("converges", () => {
    const r = solve();
    expect(r.converged).toBe(true);
    expect(r.residual).toBeLessThan(
      mirandaRegenCoolingChannel.settings.tolerance,
    );
  });

  /* ---------------- conservation ---------------- */

  it("conserves mass along the channel", () => {
    const r = solve();
    const flowOrder = [...JACKET_CELLS].reverse();
    const ids = [
      "entrance",
      ...flowOrder.slice(0, -1).map((c) => `seg${c.index}`),
      "exit",
    ];
    const mdots = ids.map((id) => r.branches[id].mdot);
    const spread =
      (Math.max(...mdots) - Math.min(...mdots)) / Math.abs(mdots[0]);
    expect(spread).toBeLessThan(1e-9);
  });

  it("matches the coolant enthalpy rise to the heat conducted through the liner", () => {
    const r = solve();
    const fluid = createFluidModel("realFluid", undefined, {
      fluidName: JACKET_DESIGN.coolant,
    });
    const inlet = r.nodes["manifoldIn"];
    const outlet = r.nodes["f1"];
    const enthalpyRise =
      mdotChannel() *
      (fluid.enthalpy(outlet.pressure, outlet.temperature) -
        fluid.enthalpy(inlet.pressure, inlet.temperature));
    const throughLiner = JACKET_CELLS.reduce(
      (s, c) => s + r.conductors![`liner${c.index}`].heatRate,
      0,
    );
    expect(enthalpyRise / throughLiner).toBeCloseTo(1, 2);
  });

  it("delivers h_eff·A·(T_aw − T_wg,solved) through every gas film", () => {
    // The whole point of the T_aw revert: the flux is NOT frozen at a
    // reference wall temperature — it is a conductance against a fixed
    // reservoir, evaluated at the SOLVED T_wg.
    const r = solve();
    for (const c of JACKET_CELLS) {
      const aw = mirandaRegenCoolingChannel.solidNodes!.find(
        (n) => n.id === `aw${c.index}`,
      )!;
      const Twg = r.solidNodes![`wg${c.index}`].temperature;
      const expected =
        c.gasFilmH *
        c.gasConvectionArea *
        (JACKET_DESIGN.adiabaticWallTemperature - Twg);
      expect(aw.type).toBe("ambient");
      expect(isParameterExpression(aw.temperature)).toBe(true);
      if (isParameterExpression(aw.temperature)) {
        expect(aw.temperature.expr).toBe("reg('tAw')");
      }
      expect(JACKET_DESIGN.adiabaticWallTemperature).toBe(3400);
      expect(
        r.conductors![`gasFilm${c.index}`].heatRate / expected,
      ).toBeCloseTo(1, 6);
    }
  });

  it("passes the gas-film heat through the liner unchanged (steady balance)", () => {
    const r = solve();
    for (const c of JACKET_CELLS) {
      const qGas = r.conductors![`gasFilm${c.index}`].heatRate;
      const qLiner = r.conductors![`liner${c.index}`].heatRate;
      expect(qLiner / qGas).toBeCloseTo(1, 6);
    }
  });

  it("accounts for the whole manifold-to-manifold pressure drop in the branches", () => {
    const r = solve();
    const flowOrder = [...JACKET_CELLS].reverse();
    const ids = [
      "entrance",
      ...flowOrder.slice(0, -1).map((c) => `seg${c.index}`),
      "exit",
    ];
    const summed = ids.reduce((s, id) => s + r.branches[id].dP, 0);
    const manifoldToManifold =
      JACKET_DESIGN.jacketInletPressure -
      JACKET_DESIGN.injectorManifoldPressure;
    expect(Math.abs(summed) / manifoldToManifold).toBeCloseTo(1, 4);
  });

  /* ---------------- the design closure ---------------- */

  it("passes the engine fuel flow at the stated pump pressure", () => {
    // This IS the sizing statement: 260 channels of this geometry pass the full
    // fuel flow when fed at JACKET_DESIGN.jacketInletPressure.
    const jacket = mdotChannel() * JACKET_DESIGN.nChannels;
    expect(jacket / JACKET_DESIGN.mdotFuel).toBeCloseTo(1, 3);
    expect(JACKET_DESIGN.jacketInletPressure).toBeGreaterThan(
      JACKET_DESIGN.chamberPressure,
    );
  });

  it("cools with n-Dodecane and drives from 3400 K ambient reservoirs", () => {
    expect(mirandaRegenCoolingChannel.fluid.params?.fluidName).toBe(
      "n-Dodecane",
    );
    // The hot gas is deliberately NOT a solved continuum — no named fluids,
    // no gas nodes; one fixed-temperature reservoir per cell instead.
    expect(mirandaRegenCoolingChannel.fluids).toBeUndefined();
    expect(
      mirandaRegenCoolingChannel.nodes.every((n) => !n.id.startsWith("g")),
    ).toBe(true);
    expect(JACKET_DESIGN.adiabaticWallTemperature).toBe(3400);
  });

  it("exposes the Bartz-plus-soot film as a k formula against hot-side registers", () => {
    const regs = mirandaRegenCoolingChannel.registers!;
    expect(regs.tAw).toBe(3400);
    expect(regs.hgThroat).toBe(12_000);
    expect(regs.bartzExp).toBe(0.9);
    const preview = previewNetworkParameters(mirandaRegenCoolingChannel);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    for (const c of JACKET_CELLS) {
      const cond = mirandaRegenCoolingChannel.conductors!.find(
        (x) => x.id === `gasFilm${c.index}`,
      )!;
      expect(cond.type.kind).toBe("conduction");
      if (cond.type.kind !== "conduction") return;
      expect(isParameterExpression(cond.type.k)).toBe(true);
      if (isParameterExpression(cond.type.k)) {
        expect(cond.type.k.expr).toContain("reg('hgThroat')");
        expect(cond.type.k.expr).toContain("reg('bartzExp')");
        expect(cond.type.k.expr).toContain("reg('rSootThroat')");
        expect(cond.type.k.expr).toContain("reg('filmFace')");
        expect(cond.type.k.expr).toContain(`node('f${c.index}').position`);
        expect(cond.type.k.expr).toContain("reg('dThroat')");
        expect(cond.type.k.expr).toContain("reg('zEnd')");
        expect(cond.type.k.expr).not.toMatch(/\d+\.\d{5,}/);
      }
      const resolved = preview.config.conductors!.find(
        (x) => x.id === `gasFilm${c.index}`,
      )!;
      if (resolved.type.kind !== "conduction") return;
      expect(resolved.type.k).toBeCloseTo(c.gasFilmH, 6);
      expect(resolved.type.area).toBeCloseTo(c.gasConvectionArea, 12);
    }
  });

  it("writes channel geometry as formulas against named registers, not silent numbers", () => {
    const cfg = mirandaRegenCoolingChannel;
    const regs = cfg.registers!;
    expect(regs.nChannels).toBe(JACKET_DESIGN.nChannels);
    expect(regs.tw).toBe(JACKET_DESIGN.ribThickness);
    expect(regs.Sw).toBe(JACKET_DESIGN.linerThickness);
    expect(regs.dThroat).toBeCloseTo(JACKET_DESIGN.throatDiameter, 12);
    expect(regs.zEnd).toBeCloseTo(JACKET_DESIGN.zEnd, 12);
    expect(regs.pJacketIn).toBe(JACKET_DESIGN.jacketInletPressure);
    expect(regs.pInjector).toBe(JACKET_DESIGN.injectorManifoldPressure);
    expect(regs.rhoLiner).toBe(8620);
    expect(regs.kLiner).toBeCloseTo(304.9, 0);
    const preview = previewNetworkParameters(cfg);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const inlet = cfg.nodes.find((n) => n.id === "manifoldIn")!;
    expect(isParameterExpression(inlet.pressure)).toBe(true);
    expect(isParameterExpression(inlet.temperature)).toBe(true);

    for (const c of JACKET_CELLS) {
      const film = cfg.conductors!.find((x) => x.id === `film${c.index}`)!;
      const liner = cfg.conductors!.find((x) => x.id === `liner${c.index}`)!;
      const coolant = cfg.nodes.find((n) => n.id === `f${c.index}`)!;
      const wc = cfg.solidNodes!.find((n) => n.id === `wc${c.index}`)!;
      const wg = cfg.solidNodes!.find((n) => n.id === `wg${c.index}`)!;
      expect(film.type.kind).toBe("convection");
      expect(liner.type.kind).toBe("conduction");
      if (film.type.kind !== "convection" || liner.type.kind !== "conduction")
        return;
      expect(isParameterExpression(film.type.area)).toBe(true);
      expect(isParameterExpression(film.type.correlation?.diameter)).toBe(true);
      expect(isParameterExpression(film.type.correlation?.flowArea)).toBe(true);
      expect(liner.type.k).toEqual({ material: "grcop-84" });
      expect(wc.cp).toEqual({ material: "grcop-84" });
      expect(wg.cp).toEqual({ material: "grcop-84" });
      expect(isParameterExpression(liner.type.area)).toBe(true);
      expect(isParameterExpression(liner.type.length)).toBe(true);
      expect(isParameterExpression(coolant.volume)).toBe(true);
      expect(isParameterExpression(wc.mass)).toBe(true);
      expect(regs[`L${c.index}`]).toBeCloseTo(c.wallLength, 12);

      const rf = preview.config.conductors!.find(
        (x) => x.id === `film${c.index}`,
      )!;
      const rl = preview.config.conductors!.find(
        (x) => x.id === `liner${c.index}`,
      )!;
      const rn = preview.config.nodes.find((n) => n.id === `f${c.index}`)!;
      if (rf.type.kind !== "convection" || rl.type.kind !== "conduction")
        return;
      expect(rf.type.area).toBeCloseTo(c.convectionArea, 10);
      expect(rf.type.correlation!.diameter).toBeCloseTo(
        c.hydraulicDiameter,
        10,
      );
      expect(rf.type.correlation!.flowArea).toBeCloseTo(c.flowArea, 12);
      expect(rl.type.k).toEqual({ material: "grcop-84" });
      expect(rl.type.area).toBeCloseTo(c.conductionArea, 12);
      expect(rl.type.length).toBe(JACKET_DESIGN.linerThickness);
      expect(rn.volume).toBeCloseTo(c.channelVolume, 12);
    }

    const entrance = cfg.branches.find((b) => b.id === "entrance")!;
    expect(entrance.component.type).toBe("customResistance");
    if (entrance.component.type !== "customResistance") return;
    expect(isParameterExpression(entrance.component.area)).toBe(true);
  });

  it("ships with the momentum-flux term on, and it is a real restriction", () => {
    expect(mirandaRegenCoolingChannel.settings.momentumFlux).toBe(true);
    // Same network, same pressures, term off: the heated, decompressing
    // coolant no longer pays the acceleration ΔP, so more flow passes.
    const off = structuredClone(mirandaRegenCoolingChannel);
    off.settings.momentumFlux = false;
    const rOff = solveSteady(off);
    expect(rOff.converged).toBe(true);
    expect(Math.abs(rOff.branches["entrance"].mdot)).toBeGreaterThan(
      mdotChannel(),
    );
  });

  it("keeps the coolant-side wall below the RP-1 coking threshold", () => {
    const r = solve();
    const maxWc = Math.max(
      ...JACKET_CELLS.map((c) => r.solidNodes![`wc${c.index}`].temperature),
    );
    // RP-1 lays down carbon in the channel from roughly 600 K of wall.
    expect(maxWc).toBeLessThan(600);
    // Sanity floor: if the wall ever sits near the coolant temperature the
    // heat load has silently vanished and the margin above is trivial.
    expect(maxWc).toBeGreaterThan(450);
  });

  it("keeps the liner well inside GRCop-84 capability", () => {
    const r = solve();
    const maxWg = Math.max(
      ...JACKET_CELLS.map((c) => r.solidNodes![`wg${c.index}`].temperature),
    );
    expect(maxWg).toBeLessThan(750);
    expect(maxWg).toBeGreaterThan(450);
  });

  it("puts the hot spot at the skirt inlet, not the throat", () => {
    // The whole point of the example.  The throat takes the highest
    // Bartz-plus-soot film and still runs cooler, because the channel is
    // narrow there and the coolant is moving fast.  The skirt inlet has
    // the coldest coolant and the slowest.  Coking is set by the cold,
    // slow end.
    const r = solve();
    const wc = (i: number) => r.solidNodes![`wc${i}`].temperature;
    const throat = JACKET_CELLS[THROAT_CELL - 1];
    const skirt = JACKET_CELLS[SKIRT_INLET_CELL - 1];

    expect(throat.gasFilmH / skirt.gasFilmH).toBeGreaterThan(1.5);
    expect(wc(SKIRT_INLET_CELL)).toBeGreaterThan(wc(THROAT_CELL));
    const hottest = JACKET_CELLS.reduce((a, b) =>
      wc(a.index) >= wc(b.index) ? a : b,
    );
    expect(hottest.index).toBe(SKIRT_INLET_CELL);
  });

  it("peaks the Bartz-plus-soot film coefficient at the throat", () => {
    const peak = JACKET_CELLS.reduce((a, b) =>
      a.gasFilmH >= b.gasFilmH ? a : b,
    );
    expect(peak.index).toBe(THROAT_CELL);
  });

  /* ---------------- the modelling assumptions the solve rests on ---------------- */

  it("stays fully turbulent, so Dittus-Boelter is in range", () => {
    const r = solve();
    const flowOrder = [...JACKET_CELLS].reverse();
    for (const c of flowOrder.slice(0, -1)) {
      expect(Math.abs(r.branches[`seg${c.index}`].reynolds)).toBeGreaterThan(
        1e4,
      );
    }
  });

  it("stays single-phase liquid: supercritical in pressure, far below T_crit", () => {
    // n-Dodecane: p_crit 1.82 MPa, T_crit 658 K.  Above p_crit there is no
    // boiling to model, which is why a single-phase channel model is legitimate
    // here and would not be at a lower jacket pressure.
    const r = solve();
    for (const c of JACKET_CELLS) {
      const n = r.nodes[`f${c.index}`];
      expect(n.pressure).toBeGreaterThan(5e6);
      expect(n.temperature).toBeLessThan(500);
    }
  });

  it("drops pressure monotonically toward the injector", () => {
    const r = solve();
    const flowOrder = [...JACKET_CELLS].reverse();
    for (let i = 1; i < flowOrder.length; i++) {
      expect(r.nodes[`f${flowOrder[i].index}`].pressure).toBeLessThan(
        r.nodes[`f${flowOrder[i - 1].index}`].pressure,
      );
    }
  });

  /* ---------------- geometry bookkeeping ---------------- */

  it("keeps the channel geometry self-consistent", () => {
    for (const c of JACKET_CELLS) {
      expect(c.flowArea).toBeCloseTo(c.width * c.depth, 12);
      expect(c.hydraulicDiameter).toBeCloseTo(
        (2 * c.width * c.depth) / (c.width + c.depth),
        12,
      );
      expect(c.finEfficiency).toBeGreaterThan(0);
      expect(c.finEfficiency).toBeLessThan(1);
      // Ribs must not eat the channel: width stays positive and the aspect
      // ratio stays a plausible rectangular duct.
      expect(c.width).toBeGreaterThan(1e-3);
      expect(c.depth / c.width).toBeLessThan(3);
    }
  });

  it("tiles the cooled length exactly, injector face to skirt exit", () => {
    expect(JACKET_CELLS[0].zStart).toBe(0);
    for (let i = 1; i < JACKET_CELLS.length; i++) {
      expect(JACKET_CELLS[i].zStart).toBe(JACKET_CELLS[i - 1].zEnd);
    }
    expect(JACKET_CELLS[JACKET_CELLS.length - 1].zEnd).toBeCloseTo(
      JACKET_DESIGN.zEnd,
      12,
    );
  });

  /* ---------------- the flat view draws the chamber ---------------- */

  describe("half-section canvas layout", () => {
    const cfg = mirandaRegenCoolingChannel;
    const fluidNode = (id: string) =>
      required(
        cfg.nodes.find((n) => n.id === id),
        id,
      );
    const solidNode = (id: string) =>
      required(
        cfg.solidNodes!.find((n) => n.id === id),
        id,
      );
    const centre = (n: { x: number; y: number }, size: number) => ({
      x: n.x + size / 2,
      y: n.y + size / 2,
    });
    const rowCentre = (id: string, cell: number) =>
      id === "f"
        ? centre(fluidNode(`${id}${cell}`), FLUID_INTERNAL_SIZE)
        : centre(solidNode(`${id}${cell}`), SOLID_NODE_SIZE);

    it("carries coolant, a T_aw reservoir, and two solid nodes per cell", () => {
      expect(JACKET_CELLS).toHaveLength(12);
      expect(cfg.nodes).toHaveLength(JACKET_CELLS.length + 2);
      expect(cfg.solidNodes).toHaveLength(3 * JACKET_CELLS.length);
      expect(cfg.conductors).toHaveLength(3 * JACKET_CELLS.length);
      expect(cfg.branches).toHaveLength(JACKET_CELLS.length + 1);
    });

    it("parks each note next to the hardware it describes, with no Firefly attribution", () => {
      expect(cfg.notes).toHaveLength(5);
      const blob = cfg.notes!.map((n) => n.text).join("\n");
      expect(blob).not.toMatch(/Firefly|Miranda/i);
      expect(blob).toMatch(/Bartz-plus-soot/);
      expect(blob).toMatch(/skirt inlet/);
      const note = (id: string) => cfg.notes!.find((n) => n.id === id)!;
      const overview = note("noteOverview");
      const canvas = note("noteCanvas");
      const hotSide = note("noteHotSide");
      const coolant = note("noteCoolant");
      const hotSpot = note("noteHotSpot");
      const injector = fluidNode("manifoldOut");
      const nozzleIn = fluidNode("manifoldIn");
      const awBarrel = solidNode("aw1");
      const awThroat = solidNode(`aw${THROAT_CELL}`);
      const awSkirt = solidNode(`aw${SKIRT_INLET_CELL}`);
      expect(Math.abs(overview.x - injector.x)).toBeLessThan(CANVAS_GRID_SIZE);
      expect(overview.y).toBeLessThan(injector.y);
      expect(Math.abs(canvas.x - awBarrel.x)).toBeLessThan(CANVAS_GRID_SIZE);
      expect(canvas.y).toBeGreaterThan(awBarrel.y);
      expect(hotSide.x).toBeGreaterThan(awThroat.x - 200);
      expect(hotSide.x).toBeLessThan(awThroat.x + 50);
      expect(hotSide.y).toBeGreaterThan(awThroat.y);
      expect(coolant.x).toBeGreaterThan(nozzleIn.x);
      expect(Math.abs(coolant.y - nozzleIn.y)).toBeLessThan(CANVAS_GRID_SIZE);
      expect(hotSpot.x).toBeGreaterThan(awSkirt.x - 250);
      expect(hotSpot.x).toBeLessThan(awSkirt.x + 50);
      expect(hotSpot.y).toBeGreaterThan(awSkirt.y);
    });

    it("runs left to right from the injector face to the skirt exit", () => {
      for (let i = 1; i < JACKET_CELLS.length; i++) {
        expect(rowCentre("f", i + 1).x).toBeGreaterThan(rowCentre("f", i).x);
      }
      expect(
        centre(fluidNode("manifoldOut"), FLUID_BOUNDARY_SIZE).x,
      ).toBeLessThan(rowCentre("f", 1).x);
      expect(
        centre(fluidNode("manifoldIn"), FLUID_BOUNDARY_SIZE).x,
      ).toBeGreaterThan(rowCentre("f", JACKET_CELLS.length).x);
    });

    it("puts canvas y on the contour radius, wide stations highest", () => {
      // +y is down, so a larger contour diameter must never sit at a larger y.
      const byDiameter = [...JACKET_CELLS].sort(
        (a, b) => a.meanDiameter - b.meanDiameter,
      );
      for (let i = 1; i < byDiameter.length; i++) {
        expect(rowCentre("f", byDiameter[i].index).y).toBeLessThanOrEqual(
          rowCentre("f", byDiameter[i - 1].index).y,
        );
      }
      // The cylindrical barrel is flat, and the two ends of the cooled length
      // are a whole contour apart.
      const barrelYs = new Set(
        JACKET_CELLS.filter((c) => c.zEnd <= 0.35).map(
          (c) => rowCentre("f", c.index).y,
        ),
      );
      expect(barrelYs.size).toBe(1);
      // The throat is the lowest point of the contour and the skirt exit the
      // highest — the pinch and the flare the example turns on.
      const ys = JACKET_CELLS.map((c) => rowCentre("f", c.index).y);
      expect(Math.max(...ys)).toBe(rowCentre("f", THROAT_CELL).y);
      expect(Math.min(...ys)).toBe(rowCentre("f", SKIRT_INLET_CELL).y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(600);
    });

    it("stacks each cell outward from the axis: T_aw, gas wall, coolant wall, coolant", () => {
      for (const c of JACKET_CELLS) {
        const aw = rowCentre("aw", c.index);
        const f = rowCentre("f", c.index);
        const wc = rowCentre("wc", c.index);
        const wg = rowCentre("wg", c.index);
        expect(f.x).toBe(wc.x);
        expect(wc.x).toBe(wg.x);
        expect(wg.x).toBe(aw.x);
        expect(f.y).toBeLessThan(wc.y);
        expect(wc.y).toBeLessThan(wg.y);
        expect(wg.y).toBeLessThan(aw.y);
      }
    });

    it("ships the coordinates the canvas renders, with no glyphs colliding", () => {
      // normalizeCanvasLayout snaps glyph centres to the canvas grid when the
      // example is loaded.  Emitting pre-snapped coordinates keeps the shipped
      // contour and the drawn contour the same shape.
      expect(normalizeCanvasLayout(cfg)).toBe(cfg);

      const glyphs = [
        ...cfg.nodes.map((n) => centre(n, fluidNodeSize(n.type))),
        ...cfg.solidNodes!.map((n) => centre(n, SOLID_NODE_SIZE)),
      ];
      let closest = Infinity;
      for (let i = 0; i < glyphs.length; i++) {
        for (let j = i + 1; j < glyphs.length; j++) {
          closest = Math.min(
            closest,
            Math.hypot(glyphs[i].x - glyphs[j].x, glyphs[i].y - glyphs[j].y),
          );
        }
      }
      // Room for the largest glyph plus the name label hung under it.
      expect(closest).toBeGreaterThanOrEqual(SOLID_NODE_SIZE + 60);
    });
  });

  /* ---------------- the builder is a real parameter study ---------------- */

  type Model = ReturnType<typeof buildRegenCoolingChannel>;
  const jacketFlow = (r: SteadyResult, m: Model) =>
    Math.abs(r.branches["entrance"].mdot) * m.design.nChannels;
  const maxWc = (r: SteadyResult, cells: JacketCell[]) =>
    Math.max(...cells.map((c) => r.solidNodes![`wc${c.index}`].temperature));

  it("passes less flow through more channels at the same pump pressure", () => {
    // More channels means more rib blocking the annulus and a smaller hydraulic
    // diameter, so the same pump pressure buys less flow.  Wall temperature is
    // NOT strongly ordered here — the h gained from the extra velocity in the
    // wide channels is spent again on the larger bulk temperature rise — which
    // is why the fair comparison is the fixed-flow one below.
    const wide = buildRegenCoolingChannel({ nChannels: 200 });
    const narrow = buildRegenCoolingChannel({ nChannels: 320 });
    const rw = solveSteady(wide.config);
    const rn = solveSteady(narrow.config);
    expect(rw.converged).toBe(true);
    expect(rn.converged).toBe(true);
    expect(jacketFlow(rw, wide)).toBeGreaterThan(jacketFlow(rn, narrow));
  });

  it("buys wall temperature with pump pressure at fixed fuel flow", () => {
    // The central regen trade, and the reason the shipped design point is where
    // it is.  Both of these pass the same 95 kg/s; the inlet pressures are the
    // ones the sizing loop returns for 200 and 320 channels (docs table).  More
    // channels run the wall cooler and cost pump head for it.
    const wide = buildRegenCoolingChannel({
      nChannels: 200,
      jacketInletPressure: 14.831e6,
    });
    const narrow = buildRegenCoolingChannel({
      nChannels: 320,
      jacketInletPressure: 19.496e6,
    });
    const rw = solveSteady(wide.config);
    const rn = solveSteady(narrow.config);
    expect(jacketFlow(rw, wide) / JACKET_DESIGN.mdotFuel).toBeCloseTo(1, 2);
    expect(jacketFlow(rn, narrow) / JACKET_DESIGN.mdotFuel).toBeCloseTo(1, 2);

    expect(maxWc(rn, narrow.cells)).toBeLessThan(maxWc(rw, wide.cells));
    expect(narrow.design.jacketInletPressure).toBeGreaterThan(
      wide.design.jacketInletPressure,
    );
    // And the shipped 260-channel point sits between the two.
    const shipped = maxWc(solve(), JACKET_CELLS);
    expect(shipped).toBeLessThan(maxWc(rw, wide.cells));
    expect(shipped).toBeGreaterThan(maxWc(rn, narrow.cells));
  });

  it("holds the Bartz-plus-soot film, and so the nominal heat, fixed under geometry changes", () => {
    // h(z) comes from the contour, not the channels, so the seed heat load
    // must not move when the channel count or liner thickness does.
    const a = buildRegenCoolingChannel({ nChannels: 200 });
    const b = buildRegenCoolingChannel({ linerThickness: 1.2e-3 });
    expect(a.design.totalHeat).toBeCloseTo(JACKET_DESIGN.totalHeat, 6);
    expect(b.design.totalHeat).toBeCloseTo(JACKET_DESIGN.totalHeat, 6);
    expect(a.cells[0].gasFilmH).toBeCloseTo(JACKET_CELLS[0].gasFilmH, 6);
  });
});
