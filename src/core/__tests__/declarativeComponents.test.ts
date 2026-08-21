import { describe, it, expect } from "vitest";
import { DpTable, CustomResistance, UserDefinedComponent } from "../components";
import { derivative, value } from "../dual";
import { compileUserComponent, UserCodeError } from "../usercode/sandbox";
import { IncompressibleLiquid } from "../fluids";
import { validateNetwork } from "../validate";
import type { NetworkConfig } from "../schema";

function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    meta: { name: "test", version: 2 },
    settings: { mode: "steady", tolerance: 1e-9, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "a",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "b",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [],
    ...overrides,
  } as NetworkConfig;
}

describe("DpTable", () => {
  const points: Array<[number, number]> = [
    [0, 0],
    [1, 1000],
    [2, 5000],
  ];

  it("interpolates piecewise-linearly inside the range", () => {
    const t = new DpTable(points);
    expect(t.pressureDrop(0.5, 1000, 1e-3)).toBe(500);
    expect(t.pressureDrop(1.5, 1000, 1e-3)).toBe(3000);
    expect(t.pressureDrop(2, 1000, 1e-3)).toBe(5000);
  });

  it("clamps by default and linearly extrapolates when configured", () => {
    const clamped = new DpTable(points, "clamp");
    expect(clamped.pressureDrop(10, 1000, 1e-3)).toBe(5000);
    const linear = new DpTable(points, "linear");
    // End segment slope = (5000-1000)/(2-1) = 4000 Pa per kg/s
    expect(linear.pressureDrop(3, 1000, 1e-3)).toBe(9000);
  });

  it("extends oddly to reverse flow when all points are nonnegative", () => {
    const t = new DpTable(points);
    expect(t.pressureDrop(-1, 1000, 1e-3)).toBe(-1000);
    expect(t.pressureDrop(-1.5, 1000, 1e-3)).toBe(-3000);
    // Odd symmetry
    expect(t.pressureDrop(-0.7, 1000, 1e-3)).toBe(
      -t.pressureDrop(0.7, 1000, 1e-3),
    );
  });

  it("anchors through the origin when the first point is above mdot=0", () => {
    const t = new DpTable([
      [1, 2000],
      [2, 5000],
    ]);
    // Segment from implicit (0,0) to (1,2000)
    expect(t.pressureDrop(0.5, 1000, 1e-3)).toBe(1000);
    expect(t.pressureDrop(-0.5, 1000, 1e-3)).toBe(-1000);
    expect(t.pressureDrop(0, 1000, 1e-3)).toBe(0);
  });

  it("uses tables with negative points as-is (no mirroring)", () => {
    const t = new DpTable(
      [
        [-2, -4000],
        [0, 0],
        [2, 4000],
      ],
      "clamp",
    );
    expect(t.pressureDrop(-1, 1000, 1e-3)).toBe(-2000);
    expect(t.pressureDrop(-5, 1000, 1e-3)).toBe(-4000); // clamped, not mirrored
  });
});

describe("CustomResistance", () => {
  it("matches FlowResistance for constant K", () => {
    const c = new CustomResistance(8, 0.01);
    const rho = 1000;
    expect(c.pressureDrop(0.5, rho, 1e-3)).toBeCloseTo(
      (8 * 0.5 * 0.5) / (2 * rho * 0.01 * 0.01),
    );
    expect(c.pressureDrop(-0.5, rho, 1e-3)).toBeCloseTo(
      -(8 * 0.5 * 0.5) / (2 * rho * 0.01 * 0.01),
    );
  });

  it("interpolates the K(Re) table and clamps outside the range", () => {
    // A = 0.01 m^2, D = 0.1 m, rho = 1000, mu = 1e-3
    // Re = rho*|v|*D/mu = 1000 * (|mdot|/10) * 0.1 / 1e-3 = 1e4 * |mdot|
    const c = new CustomResistance(
      {
        kTable: [
          [1e4, 100],
          [1e5, 10],
        ],
      },
      0.01,
      0.1,
    );
    // frac = (5e4 - 1e4)/9e4 = 4/9 → K = 100 - 90·(4/9) = 60
    expect(c.kAtRe(5e4)).toBeCloseTo(60);
    expect(c.kAtRe(1)).toBe(100); // clamp low
    expect(c.kAtRe(1e9)).toBe(10); // clamp high
    // mdot = 5 → Re = 5e4 → K = 60
    const dp = c.pressureDrop(5, 1000, 1e-3);
    expect(dp).toBeCloseTo((60 * 5 * 5) / (2 * 1000 * 0.01 * 0.01));
  });

  it("dual derivative matches finite difference (constant K)", () => {
    const c = new CustomResistance(8, 0.01);
    const mdot = 0.7;
    const d = c.pressureDropDual!({ v: mdot, d: 1 }, 1000, 1e-3);
    const eps = 1e-7;
    const fd =
      (c.pressureDrop(mdot + eps, 1000, 1e-3) -
        c.pressureDrop(mdot - eps, 1000, 1e-3)) /
      (2 * eps);
    expect(value(d)).toBeCloseTo(c.pressureDrop(mdot, 1000, 1e-3), 10);
    expect(derivative(d)).toBeCloseTo(fd, 4);
  });

  it("dual derivative matches finite difference through the K(Re) table", () => {
    const c = new CustomResistance(
      {
        kTable: [
          [1e4, 100],
          [1e5, 10],
        ],
      },
      0.01,
      0.1,
    );
    const mdot = 5; // Re = 5e4, inside the table
    const d = c.pressureDropDual!({ v: mdot, d: 1 }, 1000, 1e-3);
    const eps = 1e-6;
    const fd =
      (c.pressureDrop(mdot + eps, 1000, 1e-3) -
        c.pressureDrop(mdot - eps, 1000, 1e-3)) /
      (2 * eps);
    expect(value(d)).toBeCloseTo(c.pressureDrop(mdot, 1000, 1e-3), 8);
    expect(derivative(d)).toBeCloseTo(fd, 3);
    // Clamped region: K constant → dual slope from mdot|mdot| only
    const dLow = c.pressureDropDual!({ v: 0.5, d: 1 }, 1000, 1e-3);
    expect(derivative(dLow)).toBeCloseTo(
      (2 * 100 * 0.5) / (2 * 1000 * 0.01 * 0.01),
      8,
    );
  });
});

describe("UserDefinedComponent", () => {
  const def = compileUserComponent(
    `
defineComponent({
  metadata: { name: 'kRes', params: [{ name: 'K', default: 4 }] },
  pressureDrop(args) {
    return args.params.K * args.mdot * Math.abs(args.mdot) / (2 * args.rho * args.area * args.area);
  },
  heat(args) { return args.params.K * args.mdot * 10; },
});
`,
    "lib/kRes",
  );

  it("fits the BranchComponent signature and merges param defaults", () => {
    const c = new UserDefinedComponent(def, { area: 0.02 });
    const rho = 1000;
    expect(c.pressureDrop(0.4, rho, 1e-3)).toBeCloseTo(
      (4 * 0.4 * 0.4) / (2 * rho * 0.02 * 0.02),
    );
    expect(c.getBranchHeat!(2, 300, 4180)).toBe(4 * 2 * 10);
    expect(c.area).toBe(0.02);
    expect(c.elevationChange).toBe(0);
  });

  it("per-instance params override defaults and are frozen", () => {
    const c = new UserDefinedComponent(def, { area: 0.02, params: { K: 10 } });
    expect(c.params.K).toBe(10);
    expect(Object.isFrozen(c.params)).toBe(true);
    const dp = c.pressureDrop(0.4, 1000, 1e-3);
    expect(dp).toBeCloseTo((10 * 0.16) / (2 * 1000 * 0.0004));
  });

  it("supplies a frozen branch-scoped fluid accessor to pressure and heat callbacks", () => {
    let pressureFluid: unknown;
    let heatFluid: unknown;
    const fluidDef = {
      metadata: { name: "fluid-aware" },
      pressureDrop(args: any) {
        pressureFluid = args.fluid;
        return args.fluid.density(2e5, 300) - args.rho;
      },
      heat(args: any) {
        heatFluid = args.fluid;
        return args.fluid.cp(2e5, 300);
      },
    };
    const fluid = IncompressibleLiquid.WATER;
    const c = new UserDefinedComponent(fluidDef);
    expect(
      c.pressureDrop(
        1,
        fluid.density(2e5, 300),
        fluid.viscosity(2e5, 300),
        0,
        300,
        fluid,
      ),
    ).toBe(0);
    expect(c.getBranchHeat!(1, 300, fluid.cp(2e5, 300), fluid, 2e5)).toBe(
      fluid.cp(2e5, 300),
    );
    expect(pressureFluid).toBe(heatFluid);
    expect(Object.isFrozen(pressureFluid)).toBe(true);
  });

  it("throws a helpful UserCodeError on non-finite output", () => {
    const bad = compileUserComponent(
      `
defineComponent({
  metadata: { name: 'bad' },
  pressureDrop(args) { return args.mdot / 0; },
});
`,
      "lib/bad",
    );
    const c = new UserDefinedComponent(bad, { sourceId: "branch/b1" });
    try {
      c.pressureDrop(1, 1000, 1e-3);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UserCodeError);
      expect((e as UserCodeError).sourceId).toBe("branch/b1");
      expect((e as UserCodeError).phase).toBe("evaluate");
      expect((e as UserCodeError).message).toContain("non-finite");
    }
  });

  it("wraps user exceptions and reports the heat phase", () => {
    const thrower = compileUserComponent(
      `
defineComponent({
  metadata: { name: 't' },
  pressureDrop() { throw new Error('nope'); },
  heat() { return NaN; },
});
`,
      "lib/t",
    );
    const c = new UserDefinedComponent(thrower);
    expect(() => c.pressureDrop(1, 1, 1)).toThrow(/nope/);
    try {
      c.getBranchHeat!(1, 300, 4180);
      expect.unreachable();
    } catch (e) {
      expect((e as UserCodeError).phase).toBe("heat");
    }
    // No heat function → 0
    const noHeat = compileUserComponent(
      `
defineComponent({ metadata: { name: 'nh' }, pressureDrop() { return 0; } });
`,
      "lib/nh",
    );
    expect(new UserDefinedComponent(noHeat).getBranchHeat!(1, 300, 4180)).toBe(
      0,
    );
  });
});

describe("validation of declarative/user components", () => {
  it("accepts a valid dpTable / customResistance / userComponent network", () => {
    const cfg = makeConfig({
      branches: [
        {
          id: "b1",
          from: "a",
          to: "b",
          component: {
            type: "dpTable",
            points: [
              [0, 0],
              [1, 1000],
            ],
            extrapolate: "linear",
          },
        },
        {
          id: "b2",
          from: "a",
          to: "b",
          component: {
            type: "customResistance",
            k: {
              kTable: [
                [100, 5],
                [1000, 2],
              ],
            },
            area: 0.01,
            diameter: 0.1,
          },
        },
        {
          id: "b3",
          from: "a",
          to: "b",
          component: {
            type: "userComponent",
            component: "mine",
            params: { K: 3 },
            area: 0.01,
          },
        },
      ] as NetworkConfig["branches"],
      componentLibrary: {
        mine: {
          code: "defineComponent({ metadata: { name: 'mine' }, pressureDrop(args) { return 0; } });",
        },
      },
    });
    expect(validateNetwork(cfg)).toEqual([]);
  });

  it("rejects unsorted / non-finite dpTable points", () => {
    const mk = (points: Array<[number, number]>) =>
      makeConfig({
        branches: [
          {
            id: "b1",
            from: "a",
            to: "b",
            component: { type: "dpTable", points },
          },
        ],
      } as Partial<NetworkConfig>);
    expect(
      validateNetwork(
        mk([
          [1, 0],
          [0.5, 1],
        ]),
      ).some((e) => /strictly increasing/.test(e)),
    ).toBe(true);
    expect(
      validateNetwork(
        mk([
          [0, 0],
          [1, NaN],
        ]),
      ).some((e) => /finite/.test(e)),
    ).toBe(true);
    expect(
      validateNetwork(mk([[0, 0]])).some((e) => /at least 2/.test(e)),
    ).toBe(true);
  });

  it("rejects bad customResistance specs", () => {
    const mk = (component: unknown) =>
      makeConfig({
        branches: [{ id: "b1", from: "a", to: "b", component }],
      } as unknown as Partial<NetworkConfig>);
    expect(
      validateNetwork(mk({ type: "customResistance", k: -1, area: 0.01 })).some(
        (e) => /non-negative/.test(e),
      ),
    ).toBe(true);
    expect(
      validateNetwork(
        mk({
          type: "customResistance",
          k: { kTable: [[1, 1]] },
          area: 0.01,
          diameter: 0.1,
        }),
      ).some((e) => /at least 2/.test(e)),
    ).toBe(true);
    expect(
      validateNetwork(
        mk({
          type: "customResistance",
          k: {
            kTable: [
              [2, 1],
              [1, 1],
            ],
          },
          area: 0.01,
          diameter: 0.1,
        }),
      ).some((e) => /strictly increasing/.test(e)),
    ).toBe(true);
    expect(
      validateNetwork(
        mk({
          type: "customResistance",
          k: {
            kTable: [
              [1, 1],
              [2, 1],
            ],
          },
          area: 0.01,
        }),
      ).some((e) => /diameter/.test(e)),
    ).toBe(true);
  });

  it("rejects unknown library references and non-compiling code (no execution)", () => {
    const cfg = makeConfig({
      branches: [
        {
          id: "b1",
          from: "a",
          to: "b",
          component: { type: "userComponent", component: "ghost" },
        },
      ],
    } as Partial<NetworkConfig>);
    expect(
      validateNetwork(cfg).some((e) =>
        /unknown componentLibrary entry: ghost/.test(e),
      ),
    ).toBe(true);

    const dummyBranch = {
      id: "d",
      from: "a",
      to: "b",
      component: { type: "orifice", area: 0.01, cd: 0.6 },
    };
    const cfg2 = makeConfig({
      branches: [dummyBranch],
      componentLibrary: { bad: { code: "defineComponent({" } },
    } as unknown as Partial<NetworkConfig>);
    const errs = validateNetwork(cfg2);
    expect(errs.some((e) => /does not compile/.test(e))).toBe(true);

    // Compile-check must not execute: side-effecting code still passes.
    const cfg3 = makeConfig({
      branches: [dummyBranch],
      componentLibrary: { sneak: { code: "throw new Error('must not run')" } },
    } as unknown as Partial<NetworkConfig>);
    expect(validateNetwork(cfg3)).toEqual([]);
  });

  it("validates registers / logic / controllers shapes and expression syntax", () => {
    const good = makeConfig({
      settings: {
        mode: "transient",
        dt: 0.01,
        endTime: 0.05,
        tolerance: 1e-9,
        maxIterations: 100,
      },
      branches: [
        {
          id: "d",
          from: "a",
          to: "b",
          component: { type: "valve", area: 0.01, cd: 0.6, position: 0.5 },
        },
      ],
      registers: { pumpOn: 1 },
      logic: [
        {
          id: "l1",
          on: "stepAccepted",
          when: "node('a').P > 1e5",
          set: { pumpOn: "1 - pumpOn" },
        },
      ],
      controllers: [
        {
          id: "c1",
          type: "pid",
          sense: { kind: "node", id: "b", quantity: "pressure" },
          setpoint: 1.5e5,
          gains: { kp: 1e-6, ki: 0, kd: 0 },
          output: { kind: "valvePosition", id: "d" },
          limits: { min: 0, max: 1 },
          initialOutput: 0.5,
        },
      ],
    } as unknown as Partial<NetworkConfig>);
    expect(validateNetwork(good)).toEqual([]);

    const bad = makeConfig({
      registers: { r: NaN },
      logic: [
        { id: "l1", on: "bogus", when: "1 +" },
        { id: "l1", when: "1" },
      ],
      controllers: [
        {
          id: "c1",
          type: "",
          on: "stepStart",
          sense: { kind: "node", id: "ghost", quantity: "pressure" },
          setpoint: NaN,
          gains: { kp: Infinity, ki: 0, kd: 0 },
          output: { kind: "valvePosition", id: "ghostBranch" },
        },
      ],
    } as unknown as Partial<NetworkConfig>);
    const errs = validateNetwork(bad);
    expect(errs.some((e) => /Register "r"/.test(e))).toBe(true);
    expect(errs.some((e) => /on must be one of/.test(e))).toBe(true);
    expect(errs.some((e) => /Logic rule l1 when/.test(e))).toBe(true);
    expect(errs.some((e) => /Duplicate logic rule id/.test(e))).toBe(true);
    expect(errs.some((e) => /Controller c1 type/.test(e))).toBe(true);
    expect(
      errs.some((e) => /Controller c1 on must be 'stepAccepted'/.test(e)),
    ).toBe(true);
    expect(
      errs.some((e) =>
        /Controller c1 sense references missing node: ghost/.test(e),
      ),
    ).toBe(true);
    expect(
      errs.some((e) =>
        /Controller c1 setpoint must be a finite number/.test(e),
      ),
    ).toBe(true);
    expect(
      errs.some((e) =>
        /Controller c1 gains\.kp must be a finite number/.test(e),
      ),
    ).toBe(true);
    expect(
      errs.some((e) =>
        /Controller c1 output references missing branch: ghostBranch/.test(e),
      ),
    ).toBe(true);
    // makeConfig is steady-mode: controllers are transient-only.
    expect(
      errs.some((e) =>
        /Controllers require settings\.mode "transient"/.test(e),
      ),
    ).toBe(true);
  });
});
