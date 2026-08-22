/**
 * Rocket combustion chamber — hot gas through a choked CD nozzle.
 *
 * Pins the things that make this a rocket rather than a venturi:
 *   1. The nozzle chokes, and the solver FINDS the choked mass flow from the
 *      pressure ratio.
 *   2. Static pressure falls monotonically from the chamber to the exit plane
 *      — it does NOT recover in the bell.
 *   3. Mach rises monotonically through the sonic point to ~2.6 at the exit.
 *   4. The initialMdot warm start is present on every duct branch and
 *      survives the .fn round trip.
 *   5. The canvas is a meridional half-section of the contour.
 *
 * Both momentum-flux schemes are exercised (settings.momentumFluxScheme):
 *   - "upwind" (default): limited-upwind faces have no expansion-shock
 *     roots by construction, so the solve is seed-robust (verified below
 *     from an adversarial flat seed), at the cost of first-order accuracy
 *     at the sonic cell — choked flow lands within ~6% of analytic.
 *   - "central": the exact integral balance holds the historical sub-1%
 *     choked-flow figure and 5% isentrope tracking, but needs the authored
 *     warm start to select the physical root (see sections 3–4 below); the
 *     second-law audit certifies the selection.
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
/** The legacy exact-integral scheme — tighter accuracy, needs the seed. */
const solveCentral = (() => {
  let cached: ReturnType<typeof solveSteady> | undefined;
  return () =>
    (cached ??= solveSteady({
      ...cfg,
      settings: { ...cfg.settings, momentumFluxScheme: "central" },
    }));
})();

/** Solved station states in axial order, injector to exhaust. */
const profileOf = (r: ReturnType<typeof solveSteady>) => {
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
const profile = () => profileOf(solve());

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

  it("carries the mass-flow warm start the central-scheme transonic saddle needs", () => {
    // Load-bearing under momentumFluxScheme "central": a (mesh x relaxation)
    // sweep converged to the right root in only 5 of 30 cold-start
    // combinations, and reported converged=true on a nonsense state in 5
    // more; with the warm start it was 30 of 30. The default upwind scheme
    // converges without it (see the adversarial flat-seed test below), but
    // the example keeps the seed so it also solves cleanly under "central".
    for (const b of cfg.branches) {
      expect(b.initialMdot, b.id).toBeCloseTo(CHAMBER_DESIGN.chokedMdot, 10);
    }
  });

  it("seeds internal stations with a linear ramp, not the isentropic profile", () => {
    // The initial guess is deliberately uninformed: a linear ramp in station
    // index between the boundary states. Linear in INDEX matters for the
    // central scheme — there, flat, two-level, and z-linear guesses all
    // converge to spurious expansion-shock roots (see the module header,
    // section 3); the default upwind scheme has no such roots.
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
    // Default limited-upwind faces: first-order at the sonic cell biases
    // the discrete choked flow a few percent HIGH (measured +5.8% on this
    // 22-station grid — GFSSP-class accuracy for a system code).
    const r = solve();
    const mdot = r.branches.seg1.mdot;
    expect(mdot / CHAMBER_DESIGN.chokedMdot).toBeGreaterThan(0.98);
    expect(mdot / CHAMBER_DESIGN.chokedMdot).toBeLessThan(1.08);
    for (const b of cfg.branches) {
      expect(r.branches[b.id].mdot, b.id).toBeCloseTo(mdot, 8);
    }
    // Central scheme: friction costs a fraction of a percent against the
    // isentropic value — the historical sub-1% figure.
    const mdotC = solveCentral().branches.seg1.mdot;
    expect(mdotC / CHAMBER_DESIGN.chokedMdot).toBeGreaterThan(0.98);
    expect(mdotC / CHAMBER_DESIGN.chokedMdot).toBeLessThan(1.0);
  });

  it("finds the same physical root from an adversarial flat seed (upwind robustness)", () => {
    // The whole reason "upwind" is the default: the central scheme's
    // expansion-shock roots do not exist for it, so even a deliberately
    // uninformed warm start (chamber state everywhere, no initialMdot)
    // converges to the same physical root as the authored seed.  The same
    // flat seed under the central scheme converges to a spurious root
    // (module header, section 3 of the example's history).
    const flat = JSON.parse(JSON.stringify(cfg)) as typeof cfg;
    for (const n of flat.nodes) {
      if (n.type !== "internal") continue;
      n.pressure = CHAMBER_DESIGN.chamberPressure;
      n.temperature = CHAMBER_DESIGN.chamberTemperature;
    }
    for (const b of flat.branches) delete b.initialMdot;
    const r = solveSteady(flat);
    expect(r.converged).toBe(true);
    expect(r.branches.seg1.mdot).toBeCloseTo(solve().branches.seg1.mdot, 6);
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
    // The exit Mach carries the choked-flow bias of the default upwind
    // scheme (~6% high on this grid).
    expect(
      Math.abs(exhaust.M - CHAMBER_DESIGN.exitMach) / CHAMBER_DESIGN.exitMach,
    ).toBeLessThan(0.08);

    // The sonic crossing lives at the throat: the station one upstream is
    // subsonic and everything downstream of the throat is supersonic.  (The
    // limited-upwind faces can place the throat station itself slightly
    // above M = 1; the central scheme resolves it just under.)
    const throatIdx = M.findIndex((s) => s.id === "throat");
    expect(throatIdx).toBe(CHAMBER_DESIGN.throatIndex);
    expect(M[throatIdx - 1]!.M).toBeLessThan(1);
    expect(M[throatIdx]!.M).toBeGreaterThan(0.85);
    expect(M[throatIdx + 1]!.M).toBeGreaterThan(1);
    expect(solve().branches[`seg${throatIdx + 1}`].mach).toBeGreaterThan(1);

    // Central scheme: tight exit Mach and the strict sub-sonic throat node.
    const MC = profileOf(solveCentral());
    expect(MC[MC.length - 1]!.M).toBeCloseTo(CHAMBER_DESIGN.exitMach, 1);
    expect(MC[throatIdx]!.M).toBeGreaterThan(0.85);
    expect(MC[throatIdx]!.M).toBeLessThan(1);
  });

  it("cools the gas monotonically as it expands", () => {
    // Internal stations only for the default scheme: the exhaust boundary's
    // prescribed static temperature was authored on the central profile and
    // sits ~5 K above the upwind profile's last interior station.
    const M = profile();
    for (let i = 1; i < M.length - 1; i++) {
      expect(M[i]!.T, M[i]!.id).toBeLessThan(M[i - 1]!.T);
    }
    // Stagnation temperature is conserved, so a M ~ 2.6 exit runs far colder
    // than the chamber but nowhere near ambient.
    const exhaust = M[M.length - 1]!;
    expect(exhaust.T).toBeGreaterThan(1500);
    expect(exhaust.T).toBeLessThan(2200);
    // Central scheme: monotone through the exhaust boundary too.
    const MC = profileOf(solveCentral());
    for (let i = 1; i < MC.length; i++) {
      expect(MC[i]!.T, MC[i]!.id).toBeLessThan(MC[i - 1]!.T);
    }
  });

  it("tracks the isentropic solution away from the transonic cell", () => {
    // Default upwind scheme: the ~6% choked-flow bias shifts every station's
    // Mach by the same factor (M ∝ ṁ at fixed area and state), and the
    // stations just past the crossing carry a little extra smear (worst
    // measured: 8.3% two cells downstream of the throat).  Central scheme:
    // the historical 5%.
    for (const [prof, bar] of [
      [profile(), 0.09],
      [profileOf(solveCentral()), 0.05],
    ] as const) {
      for (let i = 0; i < prof.length; i++) {
        const station = CHAMBER_STATIONS[i]!;
        // Skip the two stations bracketing the sonic point: the crossing is
        // smeared across that cell by construction.
        if (Math.abs(i - CHAMBER_DESIGN.throatIndex) <= 1) continue;
        expect(
          Math.abs(prof[i]!.M - station.mach) / station.mach,
          `${station.id}: solved ${prof[i]!.M.toFixed(3)} vs isentropic ${station.mach.toFixed(3)}`,
        ).toBeLessThan(bar);
      }
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
