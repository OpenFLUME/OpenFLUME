import { describe, it, expect } from "vitest";
import {
  resolveColorData,
  resolveSnapshot,
  colorByGroups,
  colorByOptions,
  colorForValue,
  rampGradientStops,
  rampEndColors,
  sliderValueFromFraction,
  moveSliderEdge,
} from "../colorData";
import { NetworkConfig, SteadyResult, TransientResult } from "../types";

const baseConfig: NetworkConfig = {
  meta: { name: "Test", version: 2 },
  settings: { mode: "steady", tolerance: 1e-6, maxIterations: 200 },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "n1",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: 200000,
      temperature: 300,
      label: "n1",
    },
    {
      id: "n2",
      type: "boundary",
      x: 100,
      y: 0,
      pressure: 100000,
      temperature: 350,
      label: "n2",
    },
  ],
  branches: [
    {
      id: "b1",
      from: "n1",
      to: "n2",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      label: "b1",
    },
  ],
  solidNodes: [
    {
      id: "s1",
      type: "solid",
      x: 50,
      y: 50,
      temperature: 400,
      mass: 1,
      cp: 500,
      label: "s1",
    },
  ],
  conductors: [
    {
      id: "c1",
      from: "s1",
      to: "n1",
      type: { kind: "convection", h: 100, area: 0.01 },
      label: "c1",
    },
  ],
};

const steadyResult: SteadyResult = {
  converged: true,
  iterations: 10,
  residual: 1e-8,
  nodes: {
    n1: { pressure: 190000, temperature: 310, density: 1000 },
    n2: { pressure: 110000, temperature: 320, density: 1000 },
  },
  branches: {
    b1: { mdot: 0.5, velocity: 1.5, dP: 10000, reynolds: 10000 },
  },
  solidNodes: {
    s1: { temperature: 390 },
  },
  conductors: {
    c1: { heatRate: 5000 },
  },
};

const transientResult: TransientResult = {
  converged: true,
  times: [0, 1, 2],
  nodes: {
    n1: {
      pressure: [200000, 195000, 190000],
      temperature: [300, 305, 310],
      density: [1000, 1000, 1000],
      quality: [],
    },
    n2: {
      pressure: [100000, 105000, 110000],
      temperature: [350, 345, 320],
      density: [1000, 1000, 1000],
      quality: [],
    },
  },
  branches: {
    b1: { mdot: [0.1, 0.3, 0.5] },
  },
  solidNodes: {
    s1: { temperature: [400, 395, 390] },
  },
  conductors: {
    c1: { heatRate: [1000, 3000, 5000] },
  },
};

describe("resolveColorData", () => {
  it("editing mode returns initial conditions for pressure", () => {
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "pressure",
      null,
      false,
    );
    expect(cd.nodeValues.n1).toBe(200000);
    expect(cd.nodeValues.n2).toBe(100000);
    expect(cd.branchValues.b1).toBeUndefined();
    expect(cd.solidValues.s1).toBeUndefined();
    expect(cd.domain[0]).toBe(100000);
    expect(cd.domain[1]).toBe(200000);
  });

  it("editing mode returns initial conditions for temperature", () => {
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "temperature",
      null,
      false,
    );
    expect(cd.nodeValues.n1).toBe(300);
    expect(cd.nodeValues.n2).toBe(350);
    expect(cd.solidValues.s1).toBe(400);
    expect(cd.domain[0]).toBe(300);
    expect(cd.domain[1]).toBe(400);
  });

  it("editing mode returns density for incompressible water", () => {
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "density",
      null,
      false,
    );
    expect(cd.nodeValues.n1).toBe(1000);
    expect(cd.nodeValues.n2).toBe(1000);
    expect(cd.domain[0]).toBe(999); // min==max guard
    expect(cd.domain[1]).toBe(1001);
  });

  it("editing mode density uses the node named fluid, not only the default", () => {
    const cfg: NetworkConfig = {
      ...baseConfig,
      fluids: {
        oil: {
          model: "incompressible",
          params: { rho: 850, mu: 0.03, cp: 2000 },
        },
      },
      nodes: [
        { ...baseConfig.nodes[0] },
        { ...baseConfig.nodes[1], fluid: "oil" },
      ],
    };
    const cd = resolveColorData(
      cfg,
      null,
      null,
      "idle",
      "density",
      null,
      false,
    );
    expect(cd.nodeValues.n1).toBe(1000);
    expect(cd.nodeValues.n2).toBe(850);
  });

  it("editing mode mdot is undefined (branches muted)", () => {
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "mdot",
      null,
      false,
    );
    expect(cd.branchValues.b1).toBeUndefined();
    expect(cd.nodeValues.n1).toBeUndefined();
    expect(cd.domain).toEqual([0, 0]);
  });

  it("editing mode quality uses config quality; missing quality is muted", () => {
    const cfg: NetworkConfig = {
      ...baseConfig,
      nodes: [
        {
          id: "n1",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 200000,
          quality: 0,
          label: "n1",
        },
        {
          id: "n2",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 100000,
          quality: 0.4,
          label: "n2",
        },
        {
          id: "n3",
          type: "internal",
          x: 200,
          y: 0,
          pressure: 150000,
          label: "n3",
        },
      ],
    };
    const cd = resolveColorData(
      cfg,
      null,
      null,
      "idle",
      "quality",
      null,
      false,
    );
    expect(cd.nodeValues.n1).toBe(0);
    expect(cd.nodeValues.n2).toBe(0.4);
    expect(cd.nodeValues.n3).toBeUndefined();
    expect(cd.branchValues.b1).toBeUndefined();
    expect(cd.solidValues.s1).toBeUndefined();
    expect(cd.domain).toEqual([0, 1]);
    expect(cd.unitKind).toBe("dimensionless");
    expect(cd.signed).toBe(false);
    expect(cd.dataMode).toBe("initial");
  });

  it("editing mode quality with no values reports hasData false", () => {
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "quality",
      null,
      false,
    );
    expect(cd.hasData).toBe(false);
    expect(cd.nodeValues.n1).toBeUndefined();
    expect(cd.domain).toEqual([0, 0]);
  });

  it("steady mode returns result values", () => {
    const cd = resolveColorData(
      baseConfig,
      steadyResult,
      null,
      "idle",
      "pressure",
      null,
      false,
    );
    expect(cd.nodeValues.n1).toBe(190000);
    expect(cd.nodeValues.n2).toBe(110000);
    expect(cd.domain[0]).toBe(110000);
    expect(cd.domain[1]).toBe(190000);
  });

  it("steady mode returns branch mdot", () => {
    const cd = resolveColorData(
      baseConfig,
      steadyResult,
      null,
      "idle",
      "mdot",
      null,
      false,
    );
    expect(cd.branchValues.b1).toBe(0.5);
    expect(cd.nodeValues.n1).toBeUndefined();
    expect(cd.solidValues.s1).toBeUndefined();
  });

  it("steady mode solid node muted under mdot", () => {
    const cd = resolveColorData(
      baseConfig,
      steadyResult,
      null,
      "idle",
      "mdot",
      null,
      false,
    );
    expect(cd.solidValues.s1).toBeUndefined();
    expect(cd.conductorValues.c1).toBeUndefined();
  });

  it("steady mode quality colors fluid nodes and mutes solids/branches", () => {
    const result: SteadyResult = {
      ...steadyResult,
      nodes: {
        n1: { pressure: 190000, temperature: 310, density: 1000, quality: 0.1 },
        n2: { pressure: 110000, temperature: 320, density: 1000, quality: 0.9 },
      },
    };
    const cd = resolveColorData(
      baseConfig,
      result,
      null,
      "idle",
      "quality",
      null,
      false,
    );
    expect(cd.nodeValues.n1).toBe(0.1);
    expect(cd.nodeValues.n2).toBe(0.9);
    expect(cd.branchValues.b1).toBeUndefined();
    expect(cd.solidValues.s1).toBeUndefined();
    expect(cd.conductorValues.c1).toBeUndefined();
    expect(cd.domain).toEqual([0, 1]);
    expect(cd.dataMode).toBe("results");
  });

  it("steady mode quality keeps [0, 1] even when all nodes share one quality", () => {
    const result: SteadyResult = {
      ...steadyResult,
      nodes: {
        n1: { pressure: 190000, temperature: 310, density: 1000, quality: 0 },
        n2: { pressure: 110000, temperature: 320, density: 1000, quality: 0 },
      },
    };
    const cd = resolveColorData(
      baseConfig,
      result,
      null,
      "idle",
      "quality",
      null,
      false,
    );
    expect(cd.domain).toEqual([0, 1]);
    expect(cd.naturalDomain).toEqual([0, 1]);
  });

  it("transient with timeIndex 0 returns times[0] values", () => {
    const cd = resolveColorData(
      baseConfig,
      transientResult,
      null,
      "idle",
      "pressure",
      0,
      false,
    );
    expect(cd.nodeValues.n1).toBe(200000);
    expect(cd.nodeValues.n2).toBe(100000);
    expect(cd.branchValues.b1).toBeUndefined();
  });

  it("transient with timeIndex 1 returns times[1] values", () => {
    const cd = resolveColorData(
      baseConfig,
      transientResult,
      null,
      "idle",
      "mdot",
      1,
      false,
    );
    expect(cd.branchValues.b1).toBe(0.3);
  });

  it("transient quality at timeIndex uses quality[idx]; empty series is muted", () => {
    const withQ: TransientResult = {
      ...transientResult,
      nodes: {
        n1: { ...transientResult.nodes.n1, quality: [0, 0.3, 0.8] },
        n2: { ...transientResult.nodes.n2, quality: [] },
      },
    };
    const at1 = resolveColorData(
      baseConfig,
      withQ,
      null,
      "idle",
      "quality",
      1,
      false,
    );
    expect(at1.nodeValues.n1).toBe(0.3);
    expect(at1.nodeValues.n2).toBeUndefined();
    expect(at1.domain).toEqual([0, 1]);
    const last = resolveColorData(
      baseConfig,
      withQ,
      null,
      "idle",
      "quality",
      null,
      false,
    );
    expect(last.nodeValues.n1).toBe(0.8);
  });

  it("transient with timeIndex null defaults to last index", () => {
    const cd = resolveColorData(
      baseConfig,
      transientResult,
      null,
      "idle",
      "pressure",
      null,
      false,
    );
    expect(cd.nodeValues.n1).toBe(190000);
    expect(cd.nodeValues.n2).toBe(110000);
  });

  it("transient live coloring during running uses latest liveResult index", () => {
    const live: TransientResult = {
      converged: false,
      times: [0, 0.5],
      nodes: {
        n1: {
          pressure: [200000, 198000],
          temperature: [300, 302],
          density: [1000, 1000],
          quality: [],
        },
        n2: {
          pressure: [100000, 102000],
          temperature: [350, 348],
          density: [1000, 1000],
          quality: [],
        },
      },
      branches: {
        b1: { mdot: [0.1, 0.2] },
      },
    };
    const cd = resolveColorData(
      baseConfig,
      null,
      live,
      "running",
      "pressure",
      null,
      false,
    );
    expect(cd.nodeValues.n1).toBe(198000);
    expect(cd.nodeValues.n2).toBe(102000);
  });

  it("domain computation with min==max guard", () => {
    const cfg: NetworkConfig = {
      ...baseConfig,
      nodes: [
        {
          id: "n1",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 100000,
          temperature: 300,
          label: "n1",
        },
        {
          id: "n2",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 100000,
          temperature: 300,
          label: "n2",
        },
      ],
    };
    const cd = resolveColorData(
      cfg,
      null,
      null,
      "idle",
      "pressure",
      null,
      false,
    );
    expect(cd.domain[0]).toBe(99999);
    expect(cd.domain[1]).toBe(100001);
  });

  it("stale-result fallback to editing mode", () => {
    const cd = resolveColorData(
      baseConfig,
      steadyResult,
      null,
      "idle",
      "pressure",
      null,
      true,
    );
    // resultStale=true means canvas falls back to initial conditions
    expect(cd.nodeValues.n1).toBe(200000);
    expect(cd.nodeValues.n2).toBe(100000);
    expect(cd.domain[0]).toBe(100000);
    expect(cd.domain[1]).toBe(200000);
  });

  it("colorBy none returns empty values", () => {
    const cd = resolveColorData(
      baseConfig,
      steadyResult,
      null,
      "idle",
      "none",
      null,
      false,
    );
    expect(cd.nodeValues.n1).toBeUndefined();
    expect(cd.branchValues.b1).toBeUndefined();
    expect(cd.domain).toEqual([0, 0]);
  });
});

describe("resolveSnapshot", () => {
  it("returns empty snapshot when no result", () => {
    const snap = resolveSnapshot(baseConfig, null, null, "idle", null);
    expect(snap.nodes.n1).toEqual({});
    expect(snap.branches.b1).toEqual({});
  });

  it("steady snapshot extracts scalar values", () => {
    const snap = resolveSnapshot(baseConfig, steadyResult, null, "idle", null);
    expect(snap.nodes.n1).toEqual({
      pressure: 190000,
      temperature: 310,
      density: 1000,
    });
    expect(snap.branches.b1).toEqual({
      mdot: 0.5,
      dP: 10000,
      velocity: 1.5,
      reynolds: 10000,
    });
    expect(snap.solidNodes.s1).toEqual({ temperature: 390 });
    expect(snap.conductors.c1).toEqual({ heatRate: 5000 });
  });

  it("transient snapshot extracts values at timeIndex", () => {
    const snap = resolveSnapshot(baseConfig, transientResult, null, "idle", 1);
    expect(snap.nodes.n1).toEqual({
      pressure: 195000,
      temperature: 305,
      density: 1000,
    });
    expect(snap.branches.b1).toEqual({ mdot: 0.3 });
  });

  it("transient snapshot defaults to last index when timeIndex is null", () => {
    const snap = resolveSnapshot(
      baseConfig,
      transientResult,
      null,
      "idle",
      null,
    );
    expect(snap.nodes.n1).toEqual({
      pressure: 190000,
      temperature: 310,
      density: 1000,
    });
    expect(snap.branches.b1).toEqual({ mdot: 0.5 });
  });

  it("live result during running uses last index", () => {
    const live: TransientResult = {
      converged: false,
      times: [0, 0.5],
      nodes: {
        n1: {
          pressure: [200000, 198000],
          temperature: [300, 302],
          density: [1000, 1000],
          quality: [],
        },
        n2: {
          pressure: [100000, 102000],
          temperature: [350, 348],
          density: [1000, 1000],
          quality: [],
        },
      },
      branches: {
        b1: { mdot: [0.1, 0.2] },
      },
    };
    const snap = resolveSnapshot(baseConfig, null, live, "running", null);
    expect(snap.nodes.n1).toEqual({
      pressure: 198000,
      temperature: 302,
      density: 1000,
    });
  });
});

describe("colorForValue ramps", () => {
  it("unsigned ramp endpoints and midpoint match the 5-stop palette", () => {
    expect(colorForValue(0, [0, 10])).toBe("rgb(25, 124, 180)"); // #197cb4
    expect(colorForValue(10, [0, 10])).toBe("rgb(215, 25, 28)"); // #d7191c
    expect(colorForValue(5, [0, 10])).toBe("rgb(255, 255, 191)"); // #ffffbf
  });

  it("unsigned degenerate domain returns the mid stop", () => {
    expect(colorForValue(3, [3, 3])).toBe("rgb(255, 255, 191)");
  });

  it("undefined / non-finite values are muted", () => {
    expect(colorForValue(undefined, [0, 1])).toBe("#6b7280");
    expect(colorForValue(NaN, [0, 1])).toBe("#6b7280");
  });

  it("signed ramp is white at 0 and diverges cyan/orange", () => {
    expect(colorForValue(0, [-5, 5], true)).toBe("rgb(247, 247, 247)");
    expect(colorForValue(5, [-5, 5], true)).toBe("rgb(224, 130, 20)"); // orange
    expect(colorForValue(-5, [-5, 5], true)).toBe("rgb(22, 99, 140)"); // cyan
  });

  it("signed ramp anchors at 0 even for asymmetric domains", () => {
    // domain [-1, 3]: v=0 must still be white; v=3 → full orange
    expect(colorForValue(0, [-1, 3], true)).toBe("rgb(247, 247, 247)");
    expect(colorForValue(3, [-1, 3], true)).toBe("rgb(224, 130, 20)");
  });

  it("legend gradient matches ramp polarity", () => {
    expect(rampGradientStops(false)).toContain("rgb(25,124,180)");
    expect(rampGradientStops(true)).toContain("rgb(224,130,20)");
  });
});

describe("legend slider math", () => {
  it("rampEndColors returns the ramp's own end-stop colors, matching colorForValue at the extremes", () => {
    const [lo, hi] = rampEndColors(false);
    expect(lo.replace(/\s/g, "")).toBe(
      colorForValue(0, [0, 1], false).replace(/\s/g, ""),
    );
    expect(hi.replace(/\s/g, "")).toBe(
      colorForValue(1, [0, 1], false).replace(/\s/g, ""),
    );
  });

  it("rampEndColors differs for signed vs unsigned ramps", () => {
    expect(rampEndColors(false)).not.toEqual(rampEndColors(true));
  });

  it("sliderValueFromFraction maps 0/0.5/1 to lo/mid/hi and clamps outside [0,1]", () => {
    expect(sliderValueFromFraction([0, 400], 0)).toBe(0);
    expect(sliderValueFromFraction([0, 400], 0.5)).toBe(200);
    expect(sliderValueFromFraction([0, 400], 1)).toBe(400);
    expect(sliderValueFromFraction([0, 400], -1)).toBe(0);
    expect(sliderValueFromFraction([0, 400], 2)).toBe(400);
  });

  it("moveSliderEdge moves the dragged edge to the requested value", () => {
    expect(moveSliderEdge([100, 300], "min", 150)).toEqual([150, 300]);
    expect(moveSliderEdge([100, 300], "max", 250)).toEqual([100, 250]);
  });

  it("moveSliderEdge clamps against the other handle instead of inverting the range", () => {
    const [min, max] = moveSliderEdge([100, 300], "min", 500);
    expect(min).toBeLessThan(max);
    const [min2, max2] = moveSliderEdge([100, 300], "max", -500);
    expect(max2).toBeGreaterThan(min2);
  });

  it("moveSliderEdge keeps a nonzero gap even at the boundary, so the ramp never fully collapses", () => {
    const [min, max] = moveSliderEdge([100, 300], "min", 300);
    expect(max - min).toBeGreaterThan(0);
  });
});

describe("resolveColorData metadata", () => {
  it("colorBy none → hasData false, dataMode none", () => {
    const cd = resolveColorData(
      baseConfig,
      steadyResult,
      null,
      "idle",
      "none",
      null,
      false,
    );
    expect(cd.hasData).toBe(false);
    expect(cd.dataMode).toBe("none");
  });

  it("pre-run initial coloring → dataMode initial, legend-worthy data", () => {
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "temperature",
      null,
      false,
    );
    expect(cd.hasData).toBe(true);
    expect(cd.dataMode).toBe("initial");
  });

  it("post-run coloring → dataMode results", () => {
    const cd = resolveColorData(
      baseConfig,
      steadyResult,
      null,
      "idle",
      "pressure",
      null,
      false,
    );
    expect(cd.dataMode).toBe("results");
  });

  it("mdot is signed; pressure is not", () => {
    expect(
      resolveColorData(
        baseConfig,
        steadyResult,
        null,
        "idle",
        "mdot",
        null,
        false,
      ).signed,
    ).toBe(true);
    expect(
      resolveColorData(
        baseConfig,
        steadyResult,
        null,
        "idle",
        "pressure",
        null,
        false,
      ).signed,
    ).toBe(false);
  });

  it("quality is unsigned and dimensionless", () => {
    const result: SteadyResult = {
      ...steadyResult,
      nodes: {
        n1: { ...steadyResult.nodes.n1, quality: 0.2 },
        n2: { ...steadyResult.nodes.n2, quality: 0.7 },
      },
    };
    const cd = resolveColorData(
      baseConfig,
      result,
      null,
      "idle",
      "quality",
      null,
      false,
    );
    expect(cd.signed).toBe(false);
    expect(cd.unitKind).toBe("dimensionless");
  });

  it("mdot with no values (pre-run) reports hasData false", () => {
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "mdot",
      null,
      false,
    );
    expect(cd.hasData).toBe(false);
    expect(cd.domain).toEqual([0, 0]);
  });

  it("auto-computed domain reports domainIsOverride false", () => {
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "pressure",
      null,
      false,
    );
    expect(cd.domainIsOverride).toBe(false);
  });
});

describe("colorByOptions / colorByGroups", () => {
  it("offers every registered quantity exactly once", () => {
    const options = colorByOptions();
    const fields = options.map((o) => o.field);
    expect(new Set(fields).size).toBe(fields.length);
    for (const field of [
      "pressure",
      "temperature",
      "enthalpy",
      "mach",
      "velocity",
      "heatFlux",
    ]) {
      expect(fields, field).toContain(field);
    }
  });

  it("groups the options under the element kind that carries them", () => {
    const groups = colorByGroups();
    expect(groups.map((g) => g.label)).toEqual([
      "Fluid nodes",
      "Branches",
      "Conductors",
    ]);
    const flattened = groups.flatMap((g) => g.options.map((o) => o.field));
    // Grouping partitions the option list; it never adds or drops one.
    expect(flattened).toEqual(colorByOptions().map((o) => o.field));
    // Temperature is shared with solid nodes but listed once, under nodes.
    expect(groups[0].options.map((o) => o.field)).toContain("temperature");
  });

  it("every option is a usable ColorBy with resolvable metadata", () => {
    for (const option of colorByOptions()) {
      const cd = resolveColorData(
        baseConfig,
        steadyResult,
        null,
        "idle",
        option.field,
        null,
        false,
      );
      expect(cd.label, option.field).toBe(option.label);
      expect(cd.unitKind, option.field).toBe(option.quantity);
      expect(cd.signed, option.field).toBe(option.signed);
    }
  });
});

describe("resolveColorData domain override", () => {
  it("a valid override replaces the auto-computed domain and is flagged", () => {
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "pressure",
      null,
      false,
      [0, 500000],
    );
    expect(cd.domain).toEqual([0, 500000]);
    expect(cd.domainIsOverride).toBe(true);
    // Values themselves are untouched — only the ramp's domain changes.
    expect(cd.nodeValues.n1).toBe(200000);
  });

  it("naturalDomain always reflects the real data extent, regardless of the override", () => {
    const auto = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "pressure",
      null,
      false,
    );
    const overridden = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "pressure",
      null,
      false,
      [0, 500000],
    );
    expect(overridden.naturalDomain).toEqual(auto.domain);
    expect(overridden.naturalDomain).toEqual(auto.naturalDomain);
    expect(overridden.domain).not.toEqual(overridden.naturalDomain);
  });

  it("without an override, domain and naturalDomain coincide (handles sit at the track ends)", () => {
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "pressure",
      null,
      false,
    );
    expect(cd.domain).toEqual(cd.naturalDomain);
  });

  it("hasData still reflects real data, not the override", () => {
    // mdot has no pre-run data even though a pinned range is supplied.
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "mdot",
      null,
      false,
      [-1, 1],
    );
    expect(cd.hasData).toBe(false);
  });

  it("an inverted or degenerate override (min >= max) is ignored, falling back to auto", () => {
    const cd = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "pressure",
      null,
      false,
      [500000, 500000],
    );
    expect(cd.domainIsOverride).toBe(false);
    expect(cd.domain[0]).toBe(100000);
    expect(cd.domain[1]).toBe(200000);
  });

  it("override applies identically across editing, steady, and transient data modes", () => {
    const editing = resolveColorData(
      baseConfig,
      null,
      null,
      "idle",
      "temperature",
      null,
      false,
      [280, 420],
    );
    const steady = resolveColorData(
      baseConfig,
      steadyResult,
      null,
      "idle",
      "temperature",
      null,
      false,
      [280, 420],
    );
    const transient = resolveColorData(
      baseConfig,
      transientResult,
      null,
      "idle",
      "temperature",
      1,
      false,
      [280, 420],
    );
    expect(editing.domain).toEqual([280, 420]);
    expect(steady.domain).toEqual([280, 420]);
    expect(transient.domain).toEqual([280, 420]);
  });

  it("quality override can zoom into a sub-range of [0, 1]", () => {
    const result: SteadyResult = {
      ...steadyResult,
      nodes: {
        n1: { ...steadyResult.nodes.n1, quality: 0.2 },
        n2: { ...steadyResult.nodes.n2, quality: 0.8 },
      },
    };
    const cd = resolveColorData(
      baseConfig,
      result,
      null,
      "idle",
      "quality",
      null,
      false,
      [0.2, 0.5],
    );
    expect(cd.naturalDomain).toEqual([0, 1]);
    expect(cd.domain).toEqual([0.2, 0.5]);
    expect(cd.domainIsOverride).toBe(true);
  });

  it("quality domain expands if a value falls outside [0, 1]", () => {
    const result: SteadyResult = {
      ...steadyResult,
      nodes: {
        n1: { ...steadyResult.nodes.n1, quality: -0.1 },
        n2: { ...steadyResult.nodes.n2, quality: 1.2 },
      },
    };
    const cd = resolveColorData(
      baseConfig,
      result,
      null,
      "idle",
      "quality",
      null,
      false,
    );
    expect(cd.naturalDomain).toEqual([-0.1, 1.2]);
  });
});
