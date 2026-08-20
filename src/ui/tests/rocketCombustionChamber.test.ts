/**
 * Rocket combustion chamber — hot gas through a choked CD nozzle.
 *
 * Pins the things that make this a rocket rather than a venturi:
 *   1. The nozzle chokes, and the solver FINDS the choked mass flow from the
 *      pressure ratio (within ~1% of the analytic value).
 *   2. Static pressure falls monotonically from the chamber to the exit plane
 *      — it does NOT recover in the bell.
 *   3. Mach rises monotonically through the sonic point to ~2.6 at the exit.
 *   4. The initialMdot warm start is present on every duct branch and
 *      survives the .fn round trip; without it the transonic saddle sends the
 *      Newton to a wrong root.
 *   5. The canvas is a meridional half-section of the contour.
 */
import { describe, it, expect } from "vitest";
import { solveSteady, validateNetwork } from "../../core";
import {
  rocketCombustionChamber,
  CHAMBER_STATIONS,
  CHAMBER_DESIGN,
} from "../rocketCombustionChamber";
import { serializeText, parseText } from "../../substrate/textProjection";
import { normalizeCanvasLayout } from "../canvasLayout";
import {
  CANVAS_GRID_SIZE,
  FLUID_BOUNDARY_SIZE,
  FLUID_INTERNAL_SIZE,
  fluidNodeSize,
} from "../canvasGeometry";

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

function nodeMach(
  mdot: number,
  rho: number,
  T: number,
  diameter: number,
): number {
  const a = Math.sqrt(CHAMBER_DESIGN.gamma * CHAMBER_DESIGN.gasConstant * T);
  const A = (Math.PI / 4) * diameter * diameter;
  return mdot / (rho * A * a);
}

const cfg = rocketCombustionChamber;
const solve = (() => {
  let cached: ReturnType<typeof solveSteady> | undefined;
  return () => (cached ??= solveSteady(cfg));
})();

/** Solved station states in axial order, injector to exhaust. */
const profile = () => {
  const r = solve();
  const mdot = r.branches.seg1.mdot;
  return CHAMBER_STATIONS.map((s) => {
    const n = r.nodes[s.id];
    return {
      id: s.id,
      M: nodeMach(mdot, n.density, n.temperature, s.diameter),
      P: n.pressure,
      T: n.temperature,
    };
  });
};

describe("rocket combustion chamber (choked CD nozzle)", () => {
  it("validates with zero errors", () => {
    expect(validateNetwork(cfg)).toEqual([]);
  });

  it("is a steady ideal-gas compressible duct", () => {
    expect(cfg.settings.mode).toBe("steady");
    expect(cfg.settings.momentumFlux).toBe(true);
    expect(cfg.settings.kineticEnergy).toBe(true);
    expect(cfg.fluid.model).toBe("idealGas");
    expect(cfg.fluid.params?.gamma).toBe(CHAMBER_DESIGN.gamma);
    expect(cfg.fluid.params?.R).toBeCloseTo(CHAMBER_DESIGN.gasConstant, 10);

    // Pressure boundaries at both ends: the solver finds mdot, it is not told.
    expect(
      cfg.nodes.filter((n) => n.type === "boundary").map((n) => n.id),
    ).toEqual(["injector", "exhaust"]);
    expect(cfg.branches.every((b) => b.component.type === "pipe")).toBe(true);
    expect(cfg.branches).toHaveLength(CHAMBER_STATIONS.length - 1);
    expect(
      cfg.branches.some(
        (b) =>
          b.component.type === "pipe" && b.component.diameterOut !== undefined,
      ),
    ).toBe(true);
  });

  it("carries the mass-flow warm start the transonic saddle needs", () => {
    // Load-bearing: a (mesh x relaxation) sweep converged to the right root in
    // only 5 of 30 cold-start combinations, and reported converged=true on a
    // nonsense state in 5 more. With the warm start it was 30 of 30.
    for (const b of cfg.branches) {
      expect(b.initialMdot, b.id).toBeCloseTo(CHAMBER_DESIGN.chokedMdot, 10);
    }
  });

  it("seeds internal stations with a linear ramp, not the isentropic profile", () => {
    // The initial guess is deliberately uninformed: a linear ramp in station
    // index between the boundary states. Linear in INDEX is load-bearing —
    // flat, two-level, and z-linear guesses all converge to spurious
    // expansion-shock roots (see the module header, section 3).
    const pInj = cfg.nodes[0]!.pressure!;
    const pExh = cfg.nodes[cfg.nodes.length - 1]!.pressure!;
    const iLast = cfg.nodes.length - 1;
    cfg.nodes.forEach((n, i) => {
      if (n.type !== "internal") return;
      expect(n.pressure, n.id).toBeCloseTo(
        pInj + (pExh - pInj) * (i / iLast),
        3,
      );
    });
    // Deep in the bell the ramp sits far off the solved profile: this seed is
    // a starting guess, not the answer.
    const div11 = cfg.nodes[cfg.nodes.length - 2]!;
    const isentropicDiv11 =
      CHAMBER_DESIGN.chamberPressure *
      (1 +
        ((CHAMBER_DESIGN.gamma - 1) / 2) *
          CHAMBER_STATIONS[CHAMBER_STATIONS.length - 2]!.mach ** 2) **
        (-CHAMBER_DESIGN.gamma / (CHAMBER_DESIGN.gamma - 1));
    expect(div11.pressure! / isentropicDiv11).toBeGreaterThan(1.4);
  });

  it("keeps the warm start through the .fn text projection", () => {
    const round = parseText(serializeText(cfg));
    expect(round.errors).toEqual([]);
    const reparsed = required(round.config, "round-tripped config");
    for (const b of reparsed.branches) {
      expect(b.initialMdot, b.id).toBeCloseTo(CHAMBER_DESIGN.chokedMdot, 10);
    }
  });

  it("converges", () => {
    const r = solve();
    expect(r.converged).toBe(true);
    expect(r.residual).toBeLessThan(cfg.settings.tolerance);
  });

  it("chokes: the solver finds the analytic choked mass flow", () => {
    const r = solve();
    const mdot = r.branches.seg1.mdot;
    // Friction costs a fraction of a percent against the isentropic value.
    expect(mdot / CHAMBER_DESIGN.chokedMdot).toBeGreaterThan(0.98);
    expect(mdot / CHAMBER_DESIGN.chokedMdot).toBeLessThan(1.0);
    for (const b of cfg.branches) {
      expect(r.branches[b.id].mdot, b.id).toBeCloseTo(mdot, 8);
    }
  });

  it("drops static pressure monotonically all the way to the exit", () => {
    const M = profile();
    for (let i = 1; i < M.length; i++) {
      expect(M[i]!.P, `${M[i]!.id} vs ${M[i - 1]!.id}`).toBeLessThan(
        M[i - 1]!.P,
      );
    }
    const injector = M[0]!;
    const exhaust = M[M.length - 1]!;
    // The injector boundary is the STATIC state at the barrel's M ~ 0.15, so
    // it sits a little under the 1 MPa chamber stagnation pressure.
    expect(injector.P / CHAMBER_DESIGN.chamberPressure).toBeGreaterThan(0.98);
    expect(injector.P).toBeLessThan(CHAMBER_DESIGN.chamberPressure);
    expect(exhaust.P).toBeCloseTo(CHAMBER_DESIGN.exitPressure, 6);
    // The whole point: the bell expands, it does not diffuse.
    expect(exhaust.P / injector.P).toBeLessThan(0.05);
  });

  it("accelerates monotonically through the sonic point to a supersonic exit", () => {
    const M = profile();
    for (let i = 1; i < M.length; i++) {
      expect(M[i]!.M, `${M[i]!.id} vs ${M[i - 1]!.id}`).toBeGreaterThan(
        M[i - 1]!.M,
      );
    }
    expect(M[0]!.M).toBeLessThan(0.2);
    const exhaust = M[M.length - 1]!;
    expect(exhaust.M).toBeGreaterThan(2.5);
    expect(exhaust.M).toBeCloseTo(CHAMBER_DESIGN.exitMach, 1);

    // The sonic crossing is resolved INSIDE the cell straddling the throat, so
    // the throat station itself sits just under M = 1 while the branch through
    // it reports supersonic. Everything downstream of the throat is supersonic.
    const throatIdx = M.findIndex((s) => s.id === "throat");
    expect(throatIdx).toBe(CHAMBER_DESIGN.throatIndex);
    expect(M[throatIdx]!.M).toBeGreaterThan(0.85);
    expect(M[throatIdx]!.M).toBeLessThan(1);
    expect(M[throatIdx + 1]!.M).toBeGreaterThan(1);
    expect(solve().branches[`seg${throatIdx + 1}`].mach).toBeGreaterThan(1);
  });

  it("cools the gas monotonically as it expands", () => {
    const M = profile();
    for (let i = 1; i < M.length; i++) {
      expect(M[i]!.T, M[i]!.id).toBeLessThan(M[i - 1]!.T);
    }
    // Stagnation temperature is conserved, so a M ~ 2.6 exit runs far colder
    // than the chamber but nowhere near ambient.
    const exhaust = M[M.length - 1]!;
    expect(exhaust.T).toBeGreaterThan(1500);
    expect(exhaust.T).toBeLessThan(2200);
  });

  it("tracks the isentropic solution away from the transonic cell", () => {
    const M = profile();
    for (let i = 0; i < M.length; i++) {
      const station = CHAMBER_STATIONS[i]!;
      // Skip the two stations bracketing the sonic point: the crossing is
      // smeared across that cell by construction.
      if (Math.abs(i - CHAMBER_DESIGN.throatIndex) <= 1) continue;
      expect(
        Math.abs(M[i]!.M - station.mach) / station.mach,
        `${station.id}: solved ${M[i]!.M.toFixed(3)} vs isentropic ${station.mach.toFixed(3)}`,
      ).toBeLessThan(0.05);
    }
  });

  describe("half-section canvas layout", () => {
    const fluidNode = (id: string) =>
      required(
        cfg.nodes.find((n) => n.id === id),
        id,
      );
    const centre = (n: { x: number; y: number }, size: number) => ({
      x: n.x + size / 2,
      y: n.y + size / 2,
    });

    it("runs left to right from the injector to the exhaust", () => {
      let prevX = -Infinity;
      for (const [i, s] of CHAMBER_STATIONS.entries()) {
        const size =
          i === 0 || i === CHAMBER_STATIONS.length - 1
            ? FLUID_BOUNDARY_SIZE
            : FLUID_INTERNAL_SIZE;
        const x = centre(fluidNode(s.id), size).x;
        expect(x, s.id).toBeGreaterThan(prevX);
        prevX = x;
      }
    });

    it("puts the throat at the pinch and the chamber/exit high on the contour", () => {
      const yOf = (id: string, size: number) => centre(fluidNode(id), size).y;
      const yThroat = yOf("throat", FLUID_INTERNAL_SIZE);
      const yChamber = yOf("injector", FLUID_BOUNDARY_SIZE);
      const yExit = yOf("exhaust", FLUID_BOUNDARY_SIZE);
      // +y is down: the throat is closest to the axis, so it has the largest y.
      expect(yThroat).toBeGreaterThan(yChamber);
      expect(yThroat).toBeGreaterThan(yExit);
      expect(yThroat - yChamber).toBeGreaterThan(200);
    });

    it("ships pre-snapped coordinates and does not collide glyphs", () => {
      expect(normalizeCanvasLayout(cfg)).toBe(cfg);
      const glyphs = cfg.nodes.map((n) => ({
        id: n.id,
        ...centre(n, fluidNodeSize(n.type)),
      }));
      let closest = Infinity;
      for (let i = 0; i < glyphs.length; i++) {
        for (let j = i + 1; j < glyphs.length; j++) {
          closest = Math.min(
            closest,
            Math.hypot(
              glyphs[i]!.x - glyphs[j]!.x,
              glyphs[i]!.y - glyphs[j]!.y,
            ),
          );
        }
      }
      expect(closest).toBeGreaterThan(CANVAS_GRID_SIZE);
    });

    it("parks notes next to the hardware they describe", () => {
      expect(cfg.notes).toHaveLength(3);
      const blob = cfg.notes!.map((n) => n.text).join("\n");
      expect(blob).toMatch(/choked/i);
      expect(blob).toMatch(/supersonic/i);
      expect(blob).toMatch(/perfectly expanded/i);
      expect(blob).not.toMatch(/Firefly|Miranda/i);
    });
  });
});
