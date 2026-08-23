/**
 * Property-panel controls for schema fields the solver reads but no panel could
 * previously set: `pipe.frictionFactor`, `pipe.diameterOut`,
 * `heatedPipe.boilingModel`, `branch.initialMdot`, `node.quality`, and
 * `node.fluidFrontInlet`.
 *
 * Two properties matter more than the presence of the widgets:
 *
 *  - ABSENT IS NOT ZERO. `frictionFactor: 0` is a frictionless pipe and
 *    `quality: 0` is saturated liquid, so each of these needs an explicit mode
 *    control, and clearing one has to DELETE the key rather than write a
 *    default or leave `undefined` behind for the text projection to trip over.
 *  - The panel cannot author a config validation rejects: quality is realFluid
 *    only and mutually exclusive with temperature, and `fluidFrontInlet` is
 *    boundary-only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import PropertyPanel from "../components/PropertyPanel";
import { useStore } from "../store";
import { validateNetwork } from "../../core";
import { serializeText, parseText } from "../../substrate/textProjection";
import type { NetworkConfig, Selection } from "../types";

type Branch = NetworkConfig["branches"][number];
type Node = NetworkConfig["nodes"][number];

function config(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    meta: { name: "panel-gaps", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 200 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "a",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 3e5,
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
    branches: [
      {
        id: "p1",
        from: "a",
        to: "b",
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
    ],
    ...overrides,
  };
}

function withBranch(
  component: Branch["component"],
  extra: Partial<Branch> = {},
) {
  const base = config();
  return {
    ...base,
    branches: [{ ...base.branches[0], ...extra, component }],
  };
}

function render(cfg: NetworkConfig, selection: Selection): string {
  Object.assign(useStore.getInitialState(), {
    config: cfg,
    baseConfig: cfg,
    selection,
    result: null,
  });
  return renderToString(<PropertyPanel />).replace(/<!-- -->/g, "");
}

function resetStore(cfg: NetworkConfig, selection: Selection) {
  useStore.setState({
    config: cfg,
    baseConfig: cfg,
    selection,
    result: null,
    resultConfig: null,
    validationErrors: [],
    past: [],
    future: [],
  });
}

const s = () => useStore.getState();
const branch = () => s().config.branches[0];
const component = () => branch().component as Record<string, unknown>;
const node = (id: string) => s().config.nodes.find((n) => n.id === id)!;
const BRANCH: Selection = { kind: "branch", id: "p1" };

describe("pipe friction closure", () => {
  it("defaults to the correlation with no constant-f field", () => {
    const html = render(config(), BRANCH);
    expect(html).toContain('data-testid="pipe-friction-mode"');
    expect(html).toContain("Swamee–Jain");
    expect(html).not.toContain('data-testid="pipe-friction-factor"');
  });

  it("reveals the constant-f field when the pipe carries one", () => {
    const html = render(
      withBranch({
        type: "pipe",
        length: 1,
        diameter: 0.02,
        roughness: 1e-5,
        frictionFactor: 0.02,
      }),
      BRANCH,
    );
    expect(html).toContain('data-testid="pipe-friction-factor"');
  });

  it("treats zero f as a real setting, not an empty field", () => {
    const html = render(
      withBranch({
        type: "pipe",
        length: 1,
        diameter: 0.02,
        roughness: 1e-5,
        frictionFactor: 0,
      }),
      BRANCH,
    );
    // The mode select still reads Constant, and the pipe is described as
    // frictionless rather than as using the correlation.
    expect(html).toMatch(
      /data-testid="pipe-friction-mode"[\s\S]*?value="constant"[^>]*selected/,
    );
    expect(html).toContain("Zero f is a frictionless pipe");
  });

  it("removes the key when the mode returns to the correlation", () => {
    resetStore(
      withBranch({
        type: "pipe",
        length: 1,
        diameter: 0.02,
        roughness: 1e-5,
        frictionFactor: 0.02,
      }),
      BRANCH,
    );
    s().updateBranch("p1", {
      component: {
        ...component(),
        frictionFactor: undefined,
      } as Branch["component"],
    });
    expect("frictionFactor" in component()).toBe(false);
  });
});

describe("pipe taper", () => {
  it("is off by default and reveals the outlet diameter when enabled", () => {
    const plain = render(config(), BRANCH);
    expect(plain).toContain('data-testid="pipe-taper-toggle"');
    expect(plain).not.toContain('data-testid="pipe-diameter-out"');

    const tapered = render(
      withBranch({
        type: "pipe",
        length: 1,
        diameter: 0.02,
        roughness: 1e-5,
        diameterOut: 0.03,
      }),
      BRANCH,
    );
    expect(tapered).toContain('data-testid="pipe-diameter-out"');
  });

  it("says whether the endpoint areas actually drive the solve", () => {
    const tapered = withBranch({
      type: "pipe",
      length: 1,
      diameter: 0.02,
      roughness: 1e-5,
      diameterOut: 0.03,
    });
    expect(render(tapered, BRANCH)).toContain(
      "Enable Momentum flux and Kinetic energy",
    );
    const quasi1d = {
      ...tapered,
      settings: {
        ...tapered.settings,
        momentumFlux: true,
        kineticEnergy: true,
      },
    };
    const html = render(quasi1d, BRANCH);
    expect(html).toContain(
      "The endpoint areas feed the acceleration and kinetic-energy terms",
    );
    expect(html).not.toContain("Enable Momentum flux");
  });
});

describe("heatedPipe boiling model", () => {
  const heated = withBranch({
    type: "heatedPipe",
    length: 1,
    diameter: 0.02,
    roughness: 1e-5,
    ua: 50,
    wallTemperature: 400,
  });

  it("offers the Miropolskii option alongside the UA·ΔT fallback", () => {
    const html = render(heated, BRANCH);
    expect(html).toContain('data-testid="heated-pipe-boiling-model"');
    expect(html).toContain("Miropolskii film boiling");
    expect(html).toContain("UA·ΔT is a crude two-phase treatment");
  });

  it("explains the realFluid requirement once selected", () => {
    const html = render(
      {
        ...heated,
        branches: [
          {
            ...heated.branches[0],
            component: {
              ...heated.branches[0].component,
              boilingModel: "miropolskii",
            } as Branch["component"],
          },
        ],
      },
      BRANCH,
    );
    expect(html).toContain("Needs the realFluid model to engage");
  });

  it("clears the key when switched back to UA·ΔT", () => {
    resetStore(heated, BRANCH);
    s().updateBranch("p1", {
      component: {
        ...component(),
        boilingModel: "miropolskii",
      } as Branch["component"],
    });
    expect(component().boilingModel).toBe("miropolskii");
    s().updateBranch("p1", {
      component: {
        ...component(),
        boilingModel: undefined,
      } as Branch["component"],
    });
    expect("boilingModel" in component()).toBe(false);
  });
});

describe("branch initial flow guess", () => {
  it("reads as auto until it is set", () => {
    const html = render(config(), BRANCH);
    expect(html).toContain('data-testid="branch-initial-mdot"');
    expect(html).toContain("Auto (0.1 kg/s)");
  });

  it("explains itself as a warm start once set", () => {
    const html = render(
      withBranch(
        { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
        { initialMdot: 2.5 },
      ),
      BRANCH,
    );
    expect(html).toContain("keep Newton on the subsonic branch");
    expect(html).not.toContain("Auto (0.1 kg/s)");
  });

  it("drops the key when cleared instead of leaving undefined behind", () => {
    resetStore(
      withBranch(
        { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
        { initialMdot: 2.5 },
      ),
      BRANCH,
    );
    s().updateBranch("p1", { initialMdot: undefined });
    expect("initialMdot" in branch()).toBe(false);
    // The text projection is JSON-per-line, so a present-but-undefined key
    // would round-trip as a missing one and desynchronise the buffers.
    const parsed = parseText(serializeText(s().config));
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.branches[0]).toEqual(branch());
  });
});

describe("node state variable", () => {
  const realFluid = config({
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
  });
  const NODE_A: Selection = { kind: "node", id: "a" };

  it("stays hidden unless the node's fluid is a real fluid", () => {
    expect(render(config(), NODE_A)).not.toContain(
      'data-testid="node-state-variable"',
    );
    expect(render(realFluid, NODE_A)).toContain(
      'data-testid="node-state-variable"',
    );
  });

  it("follows the node's own named fluid, not just the default", () => {
    const mixed = config({
      fluids: { cryo: { model: "realFluid", params: { fluidName: "Oxygen" } } },
      nodes: [
        {
          id: "a",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 3e5,
          temperature: 300,
          fluid: "cryo",
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
    });
    expect(render(mixed, NODE_A)).toContain(
      'data-testid="node-state-variable"',
    );
    expect(render(mixed, { kind: "node", id: "b" })).not.toContain(
      'data-testid="node-state-variable"',
    );
  });

  it("swaps the temperature field for a quality field", () => {
    const quality = {
      ...realFluid,
      nodes: [
        { id: "a", type: "boundary", x: 0, y: 0, pressure: 3e5, quality: 0.4 },
        realFluid.nodes[1],
      ] as Node[],
    };
    const html = render(quality, NODE_A);
    expect(html).toContain('data-testid="node-quality"');
    expect(html).toContain("saturated liquid");
    // Only one of the two may exist, so the temperature input is gone.
    expect(html).not.toContain(">Temperature <");
  });

  it("keeps temperature and quality mutually exclusive through the store", () => {
    resetStore(realFluid, NODE_A);
    s().updateNode("a", { quality: 0.4, temperature: undefined });
    expect(node("a").quality).toBe(0.4);
    expect("temperature" in node("a")).toBe(false);
    expect(validateNetwork(s().config)).not.toContain(
      "Boundary node a: temperature and quality are mutually exclusive",
    );

    s().updateNode("a", { temperature: 95, quality: undefined });
    expect(node("a").temperature).toBe(95);
    expect("quality" in node("a")).toBe(false);
  });
});

describe("cryogenic front inlet", () => {
  function withFront(fluidFront: boolean): NetworkConfig {
    return config({
      solidNodes: [
        {
          id: "w",
          type: "solid",
          x: 0,
          y: 1,
          temperature: 300,
          mass: 1,
          cp: 380,
        },
      ],
      conductors: [
        {
          id: "c1",
          from: "w",
          to: "a",
          type: {
            kind: "convection",
            area: 0.01,
            correlation: {
              model: "ttWf",
              ...(fluidFront ? { fluidFront: true } : {}),
            },
          },
        },
      ],
    } as Partial<NetworkConfig>);
  }

  it("appears only once a conductor opts into front transport", () => {
    const off = render(withFront(false), { kind: "node", id: "a" });
    expect(off).not.toContain('data-testid="node-fluid-front-inlet"');
    const on = render(withFront(true), { kind: "node", id: "a" });
    expect(on).toContain('data-testid="node-fluid-front-inlet"');
  });

  it("stays off internal nodes, which validation rejects outright", () => {
    const internal = withFront(true);
    internal.nodes = [
      {
        id: "a",
        type: "internal",
        x: 0,
        y: 0,
        pressure: 3e5,
        temperature: 300,
        volume: 0.001,
      },
      internal.nodes[1],
    ];
    const html = render(internal, { kind: "node", id: "a" });
    expect(html).not.toContain('data-testid="node-fluid-front-inlet"');
  });

  it("stores a value core accepts and drops it when cleared", () => {
    resetStore(withFront(true), { kind: "node", id: "a" });
    s().updateNode("a", { fluidFrontInlet: 1 });
    expect(node("a").fluidFrontInlet).toBe(1);
    expect(
      validateNetwork(s().config).some((e) => e.includes("fluidFrontInlet")),
    ).toBe(false);
    s().updateNode("a", { fluidFrontInlet: undefined });
    expect("fluidFrontInlet" in node("a")).toBe(false);
  });
});

describe("customResistance K(Re) table", () => {
  const table: Array<[number, number]> = [
    [2000, 1.4],
    [1e5, 0.6],
  ];

  beforeEach(() =>
    resetStore(
      withBranch({
        type: "customResistance",
        k: { kTable: table },
        area: 1e-4,
        diameter: 0.01,
      }),
      BRANCH,
    ),
  );

  it("is editable in the panel rather than only in the model text", () => {
    const html = render(s().config, BRANCH);
    expect(html).toContain('data-testid="ktable-points"');
    expect(html).not.toContain("edit it in the model text view");
    expect(html).not.toContain("Edit the points in the model text view");
  });

  it("offers promotion from a constant K, seeded flat so K does not jump", () => {
    resetStore(
      withBranch({ type: "customResistance", k: 0.8, area: 1e-4 }),
      BRANCH,
    );
    const html = render(s().config, BRANCH);
    expect(html).toContain('data-testid="ktable-promote"');
    expect(html).toContain('data-testid="custom-resistance-add-diameter"');
  });

  it("shows the diameter field whenever a table needs it", () => {
    const html = render(s().config, BRANCH);
    expect(html).toContain('data-testid="custom-resistance-diameter"');
    expect(html).not.toContain('data-testid="custom-resistance-add-diameter"');
  });
});
