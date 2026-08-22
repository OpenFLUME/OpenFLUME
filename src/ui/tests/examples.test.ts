import { describe, it, expect, beforeAll } from "vitest";
import { examples } from "../examples";
import {
  validateNetwork,
  solveSteady,
  solveTransient,
  initRealFluids,
  resolveNetworkParameters,
} from "../../core";

describe("examples library: validation, convergence, and physics", () => {
  beforeAll(async () => {
    await initRealFluids();
  }, 30000);

  for (const [name, config] of Object.entries(examples)) {
    describe(name, () => {
      it("validates with zero errors", () => {
        const errs = validateNetwork(config);
        expect(errs).toEqual([]);

        for (const node of config.nodes) {
          expect(node.position?.x, `${node.id}.position.x`).toEqual(
            expect.any(Number),
          );
          expect(node.position?.y, `${node.id}.position.y`).toEqual(
            expect.any(Number),
          );
          expect(node.position?.z, `${node.id}.position.z`).toEqual(
            expect.any(Number),
          );
        }
        for (const node of config.solidNodes ?? []) {
          expect(node.position?.x, `${node.id}.position.x`).toEqual(
            expect.any(Number),
          );
          expect(node.position?.y, `${node.id}.position.y`).toEqual(
            expect.any(Number),
          );
          expect(node.position?.z, `${node.id}.position.z`).toEqual(
            expect.any(Number),
          );
        }

        if (name === "Cryogenic line cooldown") {
          const resolution = resolveNetworkParameters(config);
          expect(resolution.ok).toBe(true);
          if (!resolution.ok) return;
          const inspected = resolution.config;
          // Structural contract (cheap — no solve): kept here so a config
          // regression is caught without running the ~150 s transient below.

          // Fluid: normal hydrogen (the NBS Fig. 2 LH₂ case; C&R note —
          // test data is bracketed between normal-H₂ and para-H₂
          // predictions; the shipped example uses normal-H₂).
          expect(inspected.fluid.model).toBe("realFluid");
          expect(inspected.fluid.params?.fluidName).toBe("Hydrogen");

          // Structure: N=20 axial segments — 20 internal fluid nodes,
          // 20 solid wall nodes, 20 convection conductors, N+1=21 pipes.
          const internalFluid = inspected.nodes.filter(
            (nd) => nd.type === "internal",
          );
          expect(internalFluid).toHaveLength(20);
          expect(inspected.solidNodes).toHaveLength(20);
          expect(inspected.solidNodes!.every((sn) => sn.type === "solid")).toBe(
            true,
          );
          expect(inspected.conductors).toHaveLength(20);
          expect(
            inspected.conductors!.every((c) => c.type.kind === "convection"),
          ).toBe(true);

          // Walls carry the NIST OFHC-copper temperature-dependent cp
          // (named material — not the legacy constant 385 J/(kg·K)).
          for (const sn of inspected.solidNodes!) {
            expect(sn.cp).toEqual({ material: "ofhc-copper" });
          }

          // Convection is Miropolskii film boiling with NO literal h.
          const segLen = 61 / 20;
          const flowArea = (Math.PI / 4) * 0.0159 ** 2;
          for (let i = 1; i <= 20; i++) {
            const c = inspected.conductors![i - 1];
            expect(c.id).toBe(`conv${i}`);
            if (c.type.kind !== "convection") throw new Error("unreachable");
            expect(c.type.h).toBeUndefined();
            expect(c.type.area).toBeCloseTo(Math.PI * 0.0159 * segLen, 12);
            expect(c.type.correlation).toEqual({
              model: "miropolskii",
              diameter: 0.0159,
              flowArea,
              axialPosition: i * segLen,
            });
          }
          expect(inspected.branches).toHaveLength(21);
          expect(
            inspected.branches.every((b) => b.component.type === "pipe"),
          ).toBe(true);
          for (const b of inspected.branches) {
            if (b.component.type === "pipe") {
              expect(b.component.length).toBeCloseTo(3.05, 10);
              expect(b.component.diameter).toBeCloseTo(0.0159, 10);
            }
          }

          // Initial conditions: all fluid and wall nodes start at 300 K.
          for (const nd of internalFluid) {
            expect(nd.temperature).toBe(300);
          }
          for (const sn of inspected.solidNodes!) {
            expect(sn.temperature).toBe(300);
          }
          // Boundary conditions: saturated LH₂ in (75 psia), atm out (0.82 atm).
          const inlet = inspected.nodes.find((nd) => nd.id === "inlet")!;
          expect(inlet.pressure).toBe(517000);
          expect(inlet.quality).toBe(0);
          expect(
            inspected.nodes.find((nd) => nd.id === "outlet")!.pressure,
          ).toBe(83000);

          // Fixed stepping is load-bearing for the runtime budget with the
          // D-H closure (see the NUMERICS NOTES in examples.ts: the adaptive
          // step-doubling controller costs 3 solves/step plus rejections).
          expect(inspected.settings.timeStepping).toBe("fixed");
          expect(inspected.settings.dt).toBe(1);
        }
      });

      if (config.settings.mode === "steady") {
        it("solveSteady converges and invariants hold", () => {
          const res = solveSteady(config);
          expect(res.converged).toBe(true);

          if (name === "Three-pipe junction") {
            // Positive flow from high-pressure inlet to lower-pressure outlets
            expect(res.branches["b1"].mdot).toBeGreaterThan(0);
            expect(res.branches["b2"].mdot).toBeGreaterThan(0);
            expect(res.branches["b3"].mdot).toBeGreaterThan(0);
            // Junction pressure between inlet and outlet pressures
            const Pj = res.nodes["j"].pressure;
            expect(Pj).toBeLessThan(res.nodes["in"].pressure);
            expect(Pj).toBeGreaterThan(res.nodes["out1"].pressure);
            expect(Pj).toBeGreaterThan(res.nodes["out2"].pressure);
          }

          if (name === "Water distribution network") {
            // Pump delivers positive flow
            expect(res.branches["pump"].mdot).toBeGreaterThan(0);
            // All demand legs carry positive flow
            for (const bid of [
              "leg1_p",
              "leg1_v",
              "leg2_p",
              "leg2_v",
              "leg3_p",
              "leg3_v",
            ]) {
              expect(res.branches[bid].mdot).toBeGreaterThan(0);
            }
            // Return branches also positive
            expect(res.branches["ret1"].mdot).toBeGreaterThan(0);
            expect(res.branches["ret2"].mdot).toBeGreaterThan(0);
            // Mass balance at return merge (N5) within 1e-6 relative
            const mLegs =
              res.branches["leg1_v"].mdot +
              res.branches["leg2_v"].mdot +
              res.branches["leg3_v"].mdot;
            const mRet = res.branches["ret1"].mdot + res.branches["ret2"].mdot;
            const maxM = Math.max(Math.abs(mLegs), Math.abs(mRet), 1e-12);
            expect(Math.abs(mLegs - mRet) / maxM).toBeLessThan(1e-6);
          }

          if (name === "Spacecraft radiator panel (ammonia loop heat pipe)") {
            // Closed loop, single flow path: the wick, evaporator, vapor
            // line, all 15 condenser segments, and the liquid line carry
            // the same mass flow (no branching junctions in the loop).
            const mdot = res.branches["wick"].mdot;
            const sameFlowBranches = [
              "evapCore",
              "vaporLine",
              "liquidLine",
              ...Array.from({ length: 15 }, (_, i) => `p${i + 1}`),
            ];
            for (const bid of sameFlowBranches) {
              expect(
                Math.abs(res.branches[bid].mdot - mdot) / mdot,
                bid,
              ).toBeLessThan(1e-6);
            }

            // Circulation is evaporation-limited: the wick passes only what
            // the applied heat can boil, ~Q/h_fg. This is THE invariant that
            // separates a heat pipe from a pumped liquid loop — a pump-curve
            // closure lands here at tens of times this flow, and the vapor
            // line then carries mostly liquid at a few percent quality.
            const Q_APPLIED = 350;
            const H_FG = 1_132_131; // hfg(306 K), ammonia
            expect(mdot).toBeCloseTo(Q_APPLIED / H_FG, 4);

            // Evaporator: subcooled liquid in (single-phase, so no quality),
            // essentially pure vapor out.
            expect(res.nodes["evapIn"].quality).toBeUndefined();
            const qEvapOut = res.nodes["evapOut"].quality!;
            expect(qEvapOut).toBeGreaterThan(0.95);
            expect(qEvapOut).toBeLessThanOrEqual(1);

            // The vapor line is adiabatic transport, so the condenser sees
            // what the evaporator produced.
            const qCondIn = res.nodes["condIn"].quality!;
            expect(Math.abs(qCondIn - qEvapOut)).toBeLessThan(0.005);

            // Condensation runs monotonically down the panel and completes
            // inside it: the last strip is single-phase liquid, subcooled
            // several K below the CC set point before it returns.
            const panelOrder = [
              "f1",
              "f2",
              "f3",
              "u1",
              "f4",
              "f5",
              "f6",
              "u2",
              "f7",
              "f8",
              "f9",
              "u3",
              "f10",
              "f11",
            ];
            let qPrev = qCondIn;
            for (const nid of panelOrder) {
              const q = res.nodes[nid].quality;
              expect(q, `${nid} should still be two-phase`).toBeDefined();
              if (nid.startsWith("u")) {
                // U-bend apexes hang past the panel edge with no conductor
                // attached, so they condense nothing and carry the upstream
                // quality straight through.
                expect(q!, `${nid} is an adiabatic bend`).toBeCloseTo(qPrev, 5);
              } else {
                expect(
                  q!,
                  `${nid} quality falls along the condenser`,
                ).toBeLessThan(qPrev);
              }
              qPrev = q!;
            }
            expect(res.nodes["condOut"].quality).toBeUndefined();
            const subcooling = 306 - res.nodes["condOut"].temperature;
            expect(subcooling).toBeGreaterThan(2);
            expect(subcooling).toBeLessThan(15);

            // Two-phase condensation is isothermal: with only ~68 Pa of loop
            // Δp, Tsat barely moves, so every two-phase node sits within a
            // fraction of a K of the CC set point.
            for (const nid of ["evapOut", "condIn", ...panelOrder]) {
              expect(
                Math.abs(res.nodes[nid].temperature - 306),
                nid,
              ).toBeLessThan(0.5);
            }

            // Energy: the wick boils the full applied load, and the panel
            // radiates that plus the ~10 W the CC boundary puts back in
            // re-saturating the returning subcooled liquid (which stands in
            // for evaporator->CC back-conduction in a real loop).
            const Q_evap = res.conductors!["evapConv"].heatRate;
            expect(Q_evap).toBeCloseTo(Q_APPLIED, 0);
            let Q_rad = 0;
            for (const [cid, c] of Object.entries(res.conductors!)) {
              if (cid.startsWith("rad")) {
                expect(c.heatRate, cid).toBeGreaterThan(0);
                Q_rad += c.heatRate;
              }
            }
            const cpLiquid = 4854; // cp_l(306 K), ammonia
            const Q_makeup = mdot * cpLiquid * subcooling;
            expect(Math.abs(Q_rad - (Q_evap + Q_makeup)) / Q_rad).toBeLessThan(
              0.02,
            );

            // The temperature drops live in the hardware, not the fluid.
            // Wick-to-vapor superheat drives the load across the wick face.
            const superheat =
              res.solidNodes!["evaporator"].temperature -
              res.nodes["evapOut"].temperature;
            expect(superheat).toBeGreaterThan(3);
            expect(superheat).toBeLessThan(20);

            // 2-D conduction spreading: mid-gap fins run cooler than the
            // tube strips they bridge, every strip sits below the fluid it
            // takes heat from, and nothing approaches ammonia's 195.5 K
            // freezing point.
            expect(res.solidNodes!["fin22"].temperature).toBeLessThan(
              res.solidNodes!["w5"].temperature,
            );
            for (const [sid, s] of Object.entries(res.solidNodes!)) {
              if (sid === "space" || sid === "evaporator") continue;
              expect(s.temperature, sid).toBeGreaterThan(220);
              expect(s.temperature, sid).toBeLessThan(306);
            }
          }

          if (name === "Heated pipe with radiating wall (conjugate HT)") {
            expect(res.converged).toBe(true);
            const mdot = res.branches["b_in"].mdot;
            expect(mdot).toBeGreaterThan(0);

            // Compute total heat into fluid from convection conductors
            let Q_conv = 0;
            for (const cid of ["c1", "c2"]) {
              Q_conv += res.conductors![cid].heatRate;
            }
            // Compute radiated heat (positive toward ambient)
            let Q_rad = 0;
            for (const cid of ["c4", "c5"]) {
              const q = res.conductors![cid].heatRate;
              // heatRate is positive from -> to; amb is 'to', so positive means wall->amb
              Q_rad += q;
            }
            const cp = 4182;
            const T_in = res.nodes["in"].temperature;
            const T_outlet = res.nodes["f2"].temperature; // last internal fluid node before fixed boundary
            const expectedDeltaT = Q_conv / (mdot * cp);
            // Fluid outlet T rise within 2% of net heat / (mdot·cp)
            expect(
              Math.abs(T_outlet - T_in - expectedDeltaT) / expectedDeltaT,
            ).toBeLessThan(0.02);

            // Wall temperatures must exceed adjacent fluid temperatures
            expect(res.solidNodes!["w1"].temperature).toBeGreaterThan(
              res.nodes["f1"].temperature,
            );
            expect(res.solidNodes!["w2"].temperature).toBeGreaterThan(
              res.nodes["f2"].temperature,
            );

            // Radiation heat rate positive toward ambient
            expect(res.conductors!["c4"].heatRate).toBeGreaterThan(0);
            expect(res.conductors!["c5"].heatRate).toBeGreaterThan(0);
          }
        });
      } else {
        it("solveTransient converges and invariants hold", () => {
          const res = solveTransient(config);
          // All shipped transient examples must meet residual tolerance.
          expect(res.converged).toBe(true);

          if (name === "Tank blowdown") {
            const tankP = res.nodes["tank"].pressure;
            // Pressure monotonically decreases (allow tiny wiggle)
            for (let i = 2; i < tankP.length; i++) {
              expect(tankP[i]).toBeLessThanOrEqual(tankP[i - 1] + 1e-6);
            }
            const finalP = tankP[tankP.length - 1];
            expect(finalP).toBeGreaterThanOrEqual(101325);
            expect(finalP).toBeLessThan(tankP[0]);
            // Discharge flow positive and decreasing after initial step
            const mdots = res.branches["orifice"].mdot;
            expect(mdots[1]).toBeGreaterThan(0);
            expect(mdots[mdots.length - 1]).toBeLessThan(mdots[1]);
          }

          if (name === "Cryogenic line cooldown") {
            const lastOf = (a: number[]) => a[a.length - 1];
            // The config validates cleanly.
            expect(validateNetwork(config)).toEqual([]);

            // Physics: the quench front chills every wall below its 300 K
            // start; the inlet-adjacent wall ends near Tsat(517 kPa) ≈ 27 K;
            // chilling is sequential — wall 1 chills before wall 20.
            const tBelow50 = (tid: string) => {
              const Ts = res.solidNodes![tid].temperature;
              const i = Ts.findIndex((t) => t < 50);
              return i === -1 ? Infinity : res.times[i];
            };
            for (let i = 1; i <= 20; i++) {
              const Ts = res.solidNodes![`wall${i}`].temperature;
              expect(Ts[0]).toBe(300);
              expect(lastOf(Ts)).toBeLessThan(300);
            }
            expect(lastOf(res.solidNodes!["wall1"].temperature)).toBeLessThan(
              50,
            );
            expect(tBelow50("wall1")).toBeLessThan(tBelow50("wall20"));
          }
        });
      }
    });
  }
});
