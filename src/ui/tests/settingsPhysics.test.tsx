/**
 * Physics tab: the compressible-formulation flags and the closure-calibration
 * surface, both of which used to be reachable only by hand-editing the model
 * text (docs/user-manual.md said so outright).
 *
 * The four flags interact, so the tests pin the interlocks rather than just the
 * presence of four checkboxes: the scheme select is inert without momentum
 * flux, the second-law audit only applies to a steady central-scheme solve, and
 * the derived summary names the formulation actually in force.
 *
 * The closure tests pin the property core insists on: a config that specifies
 * no closure params must stay indistinguishable from one that never had the
 * field, so clearing a control deletes the key and empty groups are dropped.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import ConfigurationView from "../components/ConfigurationView";
import { useStore } from "../store";
import { DEFAULT_CLOSURE_PARAMS } from "../../core";
import type { NetworkConfig } from "../types";

function baseConfig(settings: Partial<NetworkConfig["settings"]> = {}) {
  return {
    meta: { name: "physics-tab", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-8,
      maxIterations: 200,
      ...settings,
    },
    fluid: { model: "idealGas", preset: "air" },
    nodes: [
      {
        id: "a",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 5e5,
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
  } as NetworkConfig;
}

function renderPhysics(config: NetworkConfig): string {
  Object.assign(useStore.getInitialState(), {
    config,
    baseConfig: config,
    settingsTab: "physics",
  });
  return renderToString(<ConfigurationView />).replace(/<!-- -->/g, "");
}

function resetStore(config: NetworkConfig) {
  useStore.setState({
    config,
    baseConfig: config,
    selection: { kind: "none" },
    result: null,
    resultConfig: null,
    validationErrors: [],
    past: [],
    future: [],
  });
}

const s = () => useStore.getState();

describe("Physics tab compressible flags", () => {
  it("renders every flag that used to be text-only", () => {
    const html = renderPhysics(baseConfig());
    expect(html).toContain('data-testid="settings-momentum-flux"');
    expect(html).toContain('data-testid="settings-kinetic-energy"');
    expect(html).toContain('data-testid="settings-momentum-scheme"');
    expect(html).toContain('data-testid="settings-transonic-admissibility"');
  });

  it("disables the scheme select until momentum flux is on", () => {
    const off = renderPhysics(baseConfig());
    expect(off).toMatch(/data-testid="settings-momentum-scheme"[^>]*disabled/);
    const on = renderPhysics(baseConfig({ momentumFlux: true }));
    expect(on).not.toMatch(
      /data-testid="settings-momentum-scheme"[^>]*disabled/,
    );
  });

  it("treats the admissibility audit as on by default", () => {
    const html = renderPhysics(
      baseConfig({ momentumFlux: true, momentumFluxScheme: "central" }),
    );
    expect(html).toMatch(
      /data-testid="settings-transonic-admissibility"[^>]*checked/,
    );
  });

  it("only enables the audit for a steady central-scheme momentum solve", () => {
    const audited =
      /data-testid="settings-transonic-admissibility"[^>]*disabled/;
    // Upwind has no expansion-shock roots to choose between.
    expect(renderPhysics(baseConfig({ momentumFlux: true }))).toMatch(audited);
    // Central, but no momentum-flux term at all.
    expect(
      renderPhysics(baseConfig({ momentumFluxScheme: "central" })),
    ).toMatch(audited);
    // Steady + momentum flux + central: applicable.
    expect(
      renderPhysics(
        baseConfig({ momentumFlux: true, momentumFluxScheme: "central" }),
      ),
    ).not.toMatch(audited);
    // Transient: the audit is a post-hoc steady check.
    expect(
      renderPhysics(
        baseConfig({
          mode: "transient",
          dt: 0.01,
          endTime: 1,
          momentumFlux: true,
          momentumFluxScheme: "central",
        }),
      ),
    ).toMatch(audited);
  });

  it("names the formulation the flags actually select", () => {
    expect(renderPhysics(baseConfig())).toContain("Incompressible baseline");
    expect(renderPhysics(baseConfig({ momentumFlux: true }))).toContain(
      "Convective acceleration only",
    );
    expect(renderPhysics(baseConfig({ kineticEnergy: true }))).toContain(
      "Stagnation-enthalpy transport only",
    );
    const both = renderPhysics(
      baseConfig({ momentumFlux: true, kineticEnergy: true }),
    );
    expect(both).toContain("Quasi-1-D compressible");
    expect(both).toContain("limited-upwind");
    const central = renderPhysics(
      baseConfig({
        momentumFlux: true,
        kineticEnergy: true,
        momentumFluxScheme: "central",
      }),
    );
    expect(central).toContain("central (exact integral)");
  });

  it("persists a flag as absent rather than false when switched off", () => {
    resetStore(baseConfig());
    s().updateSettings({ momentumFlux: true });
    expect(s().config.settings.momentumFlux).toBe(true);
    s().updateSettings({ momentumFlux: undefined });
    expect("momentumFlux" in s().config.settings).toBe(false);
  });

  it("stores only the opt-out for the default-on audit", () => {
    resetStore(baseConfig());
    // Accepting the default writes nothing.
    s().updateSettings({ transonicAdmissibility: undefined });
    expect("transonicAdmissibility" in s().config.settings).toBe(false);
    s().updateSettings({ transonicAdmissibility: false });
    expect(s().config.settings.transonicAdmissibility).toBe(false);
  });

  it("drops a cleared adaptive tolerance instead of blanking it", () => {
    resetStore(
      baseConfig({
        mode: "transient",
        endTime: 1,
        timeStepping: "adaptive",
        adaptive: { dtMin: 1e-4, dtMax: 0.1, relTol: 1e-3, absTolP: 250 },
      }),
    );
    s().updateSettings({
      adaptive: { dtMin: 1e-4, dtMax: 0.1, relTol: 1e-3, absTolP: undefined },
    });
    expect("absTolP" in (s().config.settings.adaptive ?? {})).toBe(false);
  });
});

describe("closure calibration", () => {
  beforeEach(() => resetStore(baseConfig()));

  it("renders one control per published constant, with the default shown", () => {
    const html = renderPhysics(baseConfig());
    expect(html).toContain(
      'data-testid="closure-dittusBoelter-leadingCoefficient"',
    );
    expect(html).toContain('data-testid="closure-miropolskii-yCoefficient"');
    expect(html).toContain('data-testid="closure-swameeJain-roughnessDivisor"');
    expect(html).toContain('data-testid="closure-solidCpScale"');
    // The published value is offered as the label's default note, not written
    // into the config.
    expect(html).toContain(
      `default ${DEFAULT_CLOSURE_PARAMS.swameeJain.roughnessDivisor}`,
    );
  });

  it("summarises how many constants are overridden", () => {
    expect(renderPhysics(baseConfig())).toContain("All published values");
    const config = baseConfig();
    config.closureParams = {
      dittusBoelter: { leadingCoefficient: 0.03 },
      solidCpScale: 1.2,
    };
    expect(renderPhysics(config)).toContain("2 overrides");
  });

  it("creates the block on first override and removes it on the last clear", () => {
    expect(s().config.closureParams).toBeUndefined();
    s().setClosureParam("dittusBoelter", "leadingCoefficient", 0.03);
    expect(s().config.closureParams).toEqual({
      dittusBoelter: { leadingCoefficient: 0.03 },
    });
    s().setClosureParam("dittusBoelter", "leadingCoefficient", undefined);
    // Not an empty object and not an empty group: absent, exactly as before.
    expect(s().config.closureParams).toBeUndefined();
  });

  it("drops an emptied group but keeps its siblings", () => {
    s().setClosureParam("dittusBoelter", "leadingCoefficient", 0.03);
    s().setClosureParam("swameeJain", "roughnessDivisor", 3.6);
    s().setClosureParam("dittusBoelter", "leadingCoefficient", undefined);
    expect(s().config.closureParams).toEqual({
      swameeJain: { roughnessDivisor: 3.6 },
    });
  });

  it("treats solidCpScale as a scalar beside the groups", () => {
    s().setClosureParam("solidCpScale", null, 1.35);
    expect(s().config.closureParams).toEqual({ solidCpScale: 1.35 });
    s().setClosureParam("miropolskii", "yCoefficient", 0.12);
    expect(s().config.closureParams).toEqual({
      solidCpScale: 1.35,
      miropolskii: { yCoefficient: 0.12 },
    });
    s().setClosureParam("solidCpScale", null, undefined);
    expect(s().config.closureParams).toEqual({
      miropolskii: { yCoefficient: 0.12 },
    });
  });

  it("is undoable one constant at a time", () => {
    s().setClosureParam("swameeJain", "reynoldsExponent", 0.85);
    expect(s().config.closureParams?.swameeJain?.reynoldsExponent).toBe(0.85);
    s().undo();
    expect(s().config.closureParams).toBeUndefined();
  });
});
