[Try OpenFLUME in your browser](https://openflume.github.io/OpenFLUME/)

# OpenFLUME

<p align="center">
  <img src="public/logo.svg" alt="OpenFLUME" width="420" />
</p>

[![CI](https://github.com/OpenFLUME/OpenFLUME/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenFLUME/OpenFLUME/actions/workflows/ci.yml)
[![Deploy demo](https://github.com/OpenFLUME/OpenFLUME/actions/workflows/deploy.yml/badge.svg)](https://github.com/OpenFLUME/OpenFLUME/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DOI](https://zenodo.org/badge/1341200353.svg)](https://doi.org/10.5281/zenodo.22051608)

**OpenFLUME** (Open **FLU**id **M**odel **E**nvironment) is a finite-volume thermo-fluid network simulator that runs entirely in the browser. Inspired by NASA GFSSP and SINDA/FLUINT, it solves coupled mass, momentum, and energy equations on arbitrary pipe-and-node networks using a Newton–Raphson steady solver and a backward-Euler transient solver.

**Live demo:** [openflume.github.io/OpenFLUME](https://openflume.github.io/OpenFLUME/)

**Full documentation:** [User's manual](docs/user-manual.md) — network definitions, units and sign conventions, data structure, governing equations, solution methods, interface reference, worked example problems, and the verification record.

---

## Table of Contents

1. [What It Is](#what-it-is)
2. [Quick Start](#quick-start)
3. [UI Guide](#ui-guide)
4. [Library Usage](#library-usage)
5. [Theory & Governing Equations](#theory--governing-equations)
6. [Solution Methods](#solution-methods)
7. [Config File Format (JSON Schema)](#config-file-format-json-schema)
8. [Verification](#verification)
9. [Species Transport and Reacting Flows](#species-transport-and-reacting-flows)
10. [Architecture Notes](#architecture-notes)
11. [Limitations & Roadmap](#limitations--roadmap)
12. [How to Cite](#how-to-cite)
13. [License](#license)

---

## What It Is

OpenFLUME is a local-first engineering tool for modeling 1-D fluid flow networks. It is a lumped-parameter code: with `momentumFlux` + `kineticEnergy` enabled it solves quasi-1-D compressible duct flow up to the sonic point and, when seeded, through a supersonic nozzle bell (Fanno friction choking, Rayleigh thermal choking, converging–diverging nozzles — validated against the NASA GFSSP compressible-flow verification paper), and choking at restrictions is modeled as point closures. Shock capture, Rankine–Hugoniot jumps, and acoustic wave propagation are out of scope (see [Limitations & Roadmap](#limitations--roadmap)). It combines a visual node-and-branch editor with a fully self-contained solver library written in TypeScript. The solver executes in a browser worker; the optional local companion server serves the app and discovers component files without sending models to a cloud service.

### Feature List

- **Visual Editor** – drag-and-drop palette, interactive React Flow canvas, property panels, and edge routing.
- **Steady-State Solver** – coupled Newton–Raphson with numerical Jacobian, under-relaxation, and zero-flow linearization.
- **Transient Solver** – backward Euler with mass/energy storage in node volumes. Supports optional **fluid inertia** (`(L/A)·dṁ/dt`) on pipe branches, and **trapped-gas cushions** on internal nodes (`P·V_g^n = const`) for liquid networks with entrapped air.
- **Compressible duct flow** – opt-in `momentumFlux` + `kineticEnergy` settings solve quasi-1-D compressible flow for **any** fluid model: stagnation-enthalpy transport, Fanno friction choking, Rayleigh thermal choking, and converging–diverging nozzles via tapered pipes (`pipe.diameterOut`), with per-branch Mach numbers in the results when the fluid supplies a speed of sound. Validated against the NASA GFSSP TFAWS-2007 compressible-flow verification paper.
- **Fluids** – incompressible liquid (water/oil), ideal gas (air, or custom R/γ/μ/cₚ for He, CO₂, etc.), thermal-expansion liquid (`expandableLiquid` with ρ(T)=ρ₀(1−β(T−T₀)), `waterExpandable` preset) enabling natural-circulation / buoyancy loops, and **real fluid via CoolProp** with a generated 124-fluid HEOS catalogue (favorites: Nitrogen, Oxygen, Hydrogen, ParaHydrogen, Helium, Methane, Carbon Dioxide, Water, NitrousOxide) and NIST-grade properties with true h(P,T)/u(P,T) energy equations. The ~6.5 MB WASM (~4.3 MB gzipped) is lazy-loaded only when a real fluid is first selected, keeping the main bundle small.
- **Components** (18 branch types)
  - `pipe` – Darcy–Weisbach with Swamee–Jain / laminar friction factor; optional constant `frictionFactor` and linear taper (`diameterOut`)
  - `orifice` – discharge-coefficient flow
  - `orificeCompressible` – isentropic ideal-gas orifice with choking
  - `resistance` – generic K-factor loss
  - `valve` – variable-area valve with optional position schedule
  - `checkValve` – forward orifice, reverse blocked
  - `dynamicCheckValve` – spring-mass-damper poppet ODE (transient dynamics; frozen position in the Newton solve)
  - `reliefValve` – crack-to-full-open smooth ramp with reverse blocking
  - `pump` – pressure-rise vs. volumetric-flow curve
  - `bend` – Idelchik/Crane K-factor plus arc friction
  - `areaChange` – Borda–Carnot sudden expansion / contraction
  - `cavitatingVenturi` – choked-flow closure with smooth cavitation onset (realFluid only)
  - `flowSource` – imposed mass-flow rate with optional schedule
  - `regulator` – softmin pressure regulation downstream
  - `heatedPipe` – Darcy–Weisbach plus convective heat transfer (UA, wall T)
  - `dpTable` – tabulated pressure drop versus mass flow
  - `customResistance` – constant or Reynolds-dependent K-factor resistance
  - `userComponent` – embedded trusted JavaScript pressure-drop/heat callback
- **Schedules** – time-varying boundary pressures, temperatures, valve positions, and mass-flow rates.
- **Results** – the **Results** tab is the Analysis view: a Simulation channels explorer (presets plus custom plots/CSV), collapsible run details, result tables, solver diary, and run history. Derived reporting properties include enthalpy, internal energy, entropy, viscosity, specific heat, thermal conductivity, speed of sound, Mach, mass flux, heat flux, and heat-transfer coefficient when the fluid model and geometry can supply them. Transient charts follow the canvas time scrubber.
- **Exploration (parameter sweeps)** – a session-only Sweep workspace: pick any supported scalar field, sweep it over an inclusive linear range (up to 25 variants), and solve the variants sequentially in the solver worker with per-variant status/results, cancellation, and rerun. Compare the variant table, export a provenance CSV, or promote a variant into Analysis run history. Jobs snapshot and hash the model at creation (with a staleness warning after later edits) and never mutate the model, its text, undo history, or saved files.
- **Solver diary (convergence inspection)** – every run records a bounded convergence diary from the evidence that crosses the worker boundary (throttled progress callbacks plus the final result). The Analysis view shows the outcome, a one-line digest, and an ordered event timeline with explicit retention accounting; JSON/text exports carry the config-hash provenance, and cancelled/errored runs keep a clearly-labeled partial diary.
- **Persistence** – `.fn` text save/load (lossless text projection), localStorage autosave, 12 built-in examples.
- **Validation** – pre-solve network validation with human-readable errors.
- **Conjugate Heat Transfer** – solid nodes (lumped thermal mass) and conductors (conduction, convection, radiation) coupled to the fluid network. Supports steady and transient thermal solution with full Newton–Raphson Jacobian. Temperature-dependent cp(T)/k(T) presets ship with a sourced material catalogue — OFHC copper, GRCop-84 (296–1173 K), Aluminum 6061-T6, stainless steels 304/316 (4–1600 K, NIST cryogenic + ANL-75-55), Inconel 718 (298–1375 K), PTFE, and anisotropic G-10 CR — each with documented validity ranges and end-value clamping (see [`docs/solid-properties-results.md`](docs/solid-properties-results.md)).
- **Species Transport & Reacting Flows** – optional multi-species advective transport on `idealGas` networks with node-local stiff-chemistry sub-stepping (BDF1 + dense Newton). Verified against analytical mixing, conservative transport, and Arrhenius reaction equilibria. Steady reacting flow is not supported.
- **Subnetworks** – visual group containers, per-group canvas tabs, ghost ports, and cross-boundary connections.
- **Text notes** – free-floating annotations on the canvas, saved with the model and excluded from the provenance hash so documentation never invalidates results.
- **Extensibility** – declarative pressure-drop tables and K(Re) resistances, a dedicated sidebar for creating and placing local user components, lifecycle expressions and registers, stop rules, and transient PID controllers. See [`docs/usercode.md`](docs/usercode.md).

---

## Quick Start

Requires Node.js 22 (see `.nvmrc`) and npm ≥ 10.8.

```bash
git clone https://github.com/OpenFLUME/OpenFLUME.git
cd OpenFLUME
npm install
npm run dev      # opens http://localhost:5173
```

**Immediately try a working simulation:**

1. Open the **Examples ▾** dropdown in the toolbar.
2. Select **"Three-pipe junction"** – a steady water network with one inlet boundary, one internal junction, and two outlet boundaries connected by pipes. Click **Run** and watch the toolbar show `Converged` with iteration count and residual.
3. Select **"Tank blowdown"** – a transient ideal-gas tank venting to ambient through an orifice. Click **Run** to see the time-history charts of tank pressure and orifice mass flow.

### Running Tests

```bash
# Fast pull-request tests (core, UI, and companion server)
npm test

# Type check + fast tests + production build
npm run check

# All Vitest files (expensive opt-in blocks remain skipped)
npm run test:all

# Complete end-to-end suite; builds and previews the production app
npm run test:e2e
```

See [Contributing](CONTRIBUTING.md), [Architecture](docs/architecture.md), and
[Security](SECURITY.md) for project policies and the full test tiers. Maintained
documentation is indexed in [`docs/README.md`](docs/README.md).

---

## UI Guide

### Palette

The left-side palette shows draggable node types:

- **Boundary node** – fixed pressure (and optional temperature). Flow enters or leaves here.
- **Internal node** – pressure and temperature are unknowns solved by the simulator. May have a finite volume (required for transient) and heat input.

Drag a node onto the canvas to add it.

### Adding Branches & Conductors

Pick a component type from the left palette (Pipe, Orifice, Valve, Pump, etc., or Conduction / Convection / Radiation in the **Thermal Palette**). Two connect modes are supported:

- **Click-click connect** – click a source node on the canvas, then click the target node. A hint banner appears at the top of the canvas to guide the second click. Press Escape to cancel mid-flight.
- **Drag-connect** – when a component is active in the palette, the source and target handles on every node become visible (large gold-outlined circles). Drag from a source handle to a target handle to create the branch or conductor immediately.

**Conductor connection rules:**

- **Conduction / Radiation** – both endpoints must be solid or ambient nodes.
- **Convection** – exactly one endpoint must be a fluid node, the other a solid/ambient node.
- Invalid combinations are blocked on the second click with a brief error banner.

A newly created branch or conductor is automatically selected so you can edit its parameters in the property panel.

### Property Panel

Selecting a node, branch, solid node, or conductor opens the right-side property panel:

- **Fluid nodes** – edit id, label, pressure, temperature, volume, heat input, or attach time schedules.
- **Solid / ambient nodes** – edit type (solid ↔ ambient), temperature, lumped mass, specific heat, heat input, and temperature schedules for ambient nodes. Specific heat supports five modes: constant, built-in material (catalogue with source/range shown inline), temperature table, temperature equation, and (transient-only) time table.
- **Branches** – edit component-specific fields (length, diameter, roughness, area, Cd, K, pump curve, etc.).
- **Conductors** – edit kind (conduction / convection / radiation), retarget endpoints via dropdowns, and set kind-specific parameters (thermal conductivity $k$, heat-transfer coefficient $h$, emissivity, view factor, area, length). Convection conductors offer a **Heat-transfer model** selector: specified $h$ (its box takes a constant or an equation for $h$), Dittus–Boelter, Miropolskii film boiling, Darr–Hartwig chilldown, or TT-WF chilldown.

Geometry-like fields (node volume; pipe/heated-pipe length, diameter, UA; branch areas; conductor area/length; correlation diameter/flow area; dynamic-check-valve mechanical parameters) accept **formula bindings**: click the field's **f(x)** button to pick a valid model reference or helper (e.g. `pipe('seg1').surfaceArea`) — the formula is resolved once against the static model before each solve, with an inline preview in the current display unit. See [`docs/parameter-bindings.md`](docs/parameter-bindings.md) for the scope, allowlist, and semantics.

### Settings

Click **Settings** in the toolbar to open the dialog:

- **Solver** – **Steady** or **Transient**, with tolerance, max iterations, and relaxation. Transient adds **Fixed dt** or **Adaptive** (min/max/initial dt, relative tolerance, safety factor) plus end time. Internal nodes must have a non-zero `volume`.
- **Fluids** – a roster of the default fluid plus named isolated continua (**+ Add fluid**). Each card selects Incompressible / Ideal Gas / Expandable Liquid / Real fluid (CoolProp), with presets or the searchable 124-fluid catalogue for real fluids.
- **Units** – display preset (SI, Metric engineering, US customary) and per-quantity preferences.
- **Advanced Extensibility** – JSON editors for registers, logic rules, and PID controllers.

### Running

Click **Run**. The toolbar shows convergence status:

- Steady: `Converged | Iter N | Residual 1.23e-09`
- Transient: `Converged | Steps N`

Validation errors (e.g., disconnected graph, missing volumes in transient) appear in red next to the status.

### Results & Charts

The **Results** tab is the Analysis view. A sticky run strip identifies the displayed run; the primary pane is the **Simulation channels** explorer with view presets (pressure, temperature, mass flow, Mach / mass flux, enthalpy, heat flux, quality / front / wetted fraction, and more) plus a custom-channel mode, CSV export of the current view or every channel, collapsible **Run details** / **Result tables** / **Solver diary** / **Run history**, and provenance on every export. Live transients build charts as steps complete; cancelled runs keep a clearly labeled partial trajectory.

### Canvas Visualization (Color-by & Time Scrubbing)

The canvas supports **property-based coloring** so you can visualize the spatial distribution of any solved quantity:

- **Color-by modes** – the top-right **Color by** dropdown is generated from the same channel registry as the Analysis explorer. It offers `None` plus every quantity a result can carry: node pressure / temperature / density / enthalpy / internal energy / entropy / specific heat / viscosity / thermal conductivity / speed of sound / gas volume / quality / front fraction; branch mass flow / pressure drop / velocity / volumetric flow / mass flux / dynamic pressure / Reynolds / Mach; conductor heat rate / heat flux / heat-transfer coefficient / wetted fraction. Elements a quantity does not apply to are muted gray.
- **Colormap** – shared blue→red scale across all element types. The legend (bottom-right) shows the current quantity name, unit, and min/max domain.
- **Data source** – while editing (no result, or a stale result), nodes show initial / boundary conditions; after a steady run, values come from the converged result; after a transient run, from the time step selected by the scrubber (during a run the canvas follows the latest available step).
- **Time scrubber** – after a transient run completes (or is cancelled with partial data), a slider appears at the bottom of the canvas. Dragging it updates the canvas colors and all node/edge value overlays to reflect the state at that moment.

### Subnetworks (Groups)

The canvas supports visual grouping for large networks:

- **Group from selection** – select two or more nodes and choose **Create subnetwork** from the selection-actions menu (or press Ctrl/Cmd+G). A colored container appears on the main canvas.
- **Group tabs** – double-click a group container (or select it and click **Open Tab** in the property panel) to open a closable per-group canvas tab. Inside the tab you see only the member nodes plus **ghost port nodes** for any cross-boundary connections.
- **Cross-boundary branches** – branches that connect a node inside a group to a node outside are shown as dashed edges on the main canvas. You can retarget either endpoint via the branch property-panel dropdown.
- **Ungroup** – select the group container and click **Ungroup** in the property panel; nodes return to the main canvas and their positions are preserved.

The solver ignores groups entirely; a grouped network produces exactly the same numerical results as an ungrouped one.

### Text Notes

Notes document a model for whoever opens it next — assumptions, sources for a
loss coefficient, review remarks:

- **Place** – click or drag the note tool (the lined card in the canvas rail). A
  new note opens ready to type; drag it anywhere, and it snaps to the grid.
- **Edit** – double-click a note to edit it in place (Escape discards, Cmd/Ctrl+Enter
  commits), or use the **Text** field in the property panel. Selecting a note and
  pressing Delete removes it, as does **Delete note** in the panel.
- **Resize** – a note grows downward with its text until you drag the corner handle
  (shown on hover or selection), which pins an explicit box that the text then
  scrolls inside. The panel's **Width** / **Height** fields do the same from the
  keyboard; clear either one to go back to fitting the text.
- **Scope** – notes placed inside a subnetwork tab stay pinned there; ungrouping
  returns them to the main canvas. The **Notes** table in the Table tab lists them
  all and is searchable.

Notes are saved with the model and are fully undoable, but they are inert: the
solver never reads them and they are excluded from the provenance hash, so
writing or fixing a note never marks results stale or invalidates a run-history
baseline.

### Save / Load

- **Save** – downloads the current network as a `.fn` file: a line-oriented, lossless text projection of the canonical `NetworkConfig` (includes `groups[]`, `notes[]`, and `node.group` when present).
- **Load** – imports a `.fn` text file (parse errors are reported with line numbers and never replace the current network).
- **Autosave** – every edit is autosaved to `localStorage`; reloading the page restores your last network.
- **Text tab** – the same text projection as a full-workspace source editor: keystrokes stay local until **Apply** (Cmd/Ctrl+Enter), which commits valid text as exactly one undoable history entry; invalid text is kept with line-level diagnostics and never reaches the model. Selection syncs with the diagram in both directions.

### Parameter Sweeps (Exploration)

The **Sweep** tab is a session-only workspace for exploring one scalar parameter at a time:

- **Define** – choose any supported scalar field (settings, fluid/solid node, branch component, or conductor fields), then set inclusive start/end and a variant count (1–25, linear spacing). Values are entered in config-native SI units.
- **Run** – variants solve strictly sequentially in the solver worker. A failed variant is recorded and the sweep continues; **Cancel** keeps completed rows; **Rerun** reuses the frozen variant configs.
- **Isolation & export** – each job solves a frozen, hashed snapshot of the model (later edits raise a staleness banner) and never touches the model, the text buffer, undo history, or localStorage. The variant table shows convergence and result envelopes; **Export CSV** downloads one row per variant with hash provenance; **Promote** appends a variant's result to Analysis run history.

### Solver Diary (Convergence Inspection)

Every solve records a lightweight **convergence diary** (`src/ui/convergenceDiary.ts`) — a bounded log built only from evidence that crosses the worker boundary (the throttled progress stream plus the final result). The Analysis view shows the outcome (converged / not converged / stopped short / user-terminated / cancelled / error), a one-line digest, and the ordered event timeline with explicit retention accounting. Cancelled or errored runs keep a clearly-labeled _partial_ diary, selecting a historical run restores its diary, and exports (JSON / plain text) include the model name, solver-settings summary, and config hash. Stall warnings are phrased in throttled _progress samples_ (not solver iterations), and diaries synthesized from a bare final result say so (`finalEvidenceOnly`) instead of fabricating progress milestones.

### Examples

The **Examples ▾** dropdown shows 13 pre-built networks grouped into _Verify-by-inspection_, _Applications_, _Benchmarks_, and _Extensibility_.

#### Verify-by-inspection examples

This case has a closed-form expected value embedded as a canvas label so you can verify correctness by eye after clicking **Run**:

- **Sanity: orifice hand-calc** – incompressible orifice; mass flow matches Cd·A·√(2ρΔP) ≈ 0.8485 kg/s within 0.5%.

#### Applications

- **Three-pipe junction** – classic steady split-flow problem (one inlet, two outlets).
- **Tank blowdown** – ideal-gas transient depressurization through an orifice.
- **Water distribution network** – steady pump-and-pipe distribution tree with three demand legs and elevation changes.
- **Heated pipe with radiating wall (conjugate HT)** – steady water pipe with wall solid nodes, convection to fluid, conduction between wall segments, and radiation to a 300 K ambient.
- **Spacecraft radiator panel (ammonia loop heat pipe)** – steady ammonia LHP rejecting 400 W of avionics heat: a wicked evaporator (capillary pumping modelled as a fixed pump curve) feeds a four-pass flat radiator panel with genuine 2-D in-plane face-sheet conduction, radiating to deep space; laid out in the x-y plane for the 3D view.
- **LOX/RP-1 thruster (combustor)** – reacting junction (NASA CEA tables inside the Newton system) feeding a choked converging–diverging nozzle with a 22-station three-layer regenerative RP-1 jacket. Chamber pressure, O/F, and product-gas properties are solved, not prescribed; see [`docs/combustion.md`](docs/combustion.md).

#### Benchmarks

- **Water-water counterflow heat exchanger** – GFSSP Example 5; the N=12 model reaches published outlet temperatures within 0.44 K (hot) and 0.19 K (cold).
- **Entrapped-air line** – GFSSP Figure 10 (Lee & Martin): transient water line with fluid inertia on all pipe segments and a polytropic gas cushion at the downstream end.
- **Cryogenic line cooldown** – NBS Report 9264, Figure 2 (SINDA/FLUINT validation case): saturated LH₂ at 75 psia admitted to a 61 m copper line (15.9 mm ID) initially at 300 K, venting to 0.82 atm; each of the 20 axial segments carries a copper wall thermal mass with temperature-dependent NIST OFHC-copper cp(T) and Miropolskii film-boiling convection.

#### Extensibility

- **Extension: Cryo tank vent control (transient)** – pressurized LN₂ ullage (real-fluid nitrogen, ~3.2 bar) with a 400 W parasitic heat leak; logic opens/closes a vent valve at a 5 psi hysteresis band (`P_high` / `P_low`) while registers track `ventOpen`, peak pressure, and vent events.
- **LH2 tank no-vent fill** – SINDA/FLUINT Sample Problem F, model `TVS`: a half-full, saturated 42-inch LH₂ tank filled from a colder 60 psia source while the thermodynamic vent system keeps bleeding liquid. FLUINT's **twinned tanks** and **moveable ties** have no direct equivalent in the schema, so both are _emulated_ out of registers, logic rules, and register controllers — the liquid and vapor control volumes are boundary nodes whose (P, T) are integrated in logic and imposed each step, with all densities and enthalpies read back from CoolProp ParaHydrogen, and the nine wall ties reattach between the twins as the level moves. The ullage is free to superheat, with a condensing film on each subcooled dry wall segment setting the condensation rate. At 15 min it reproduces the deck within ~1%: fill 73.4% (deck 73.9), 59.63 psia (59.72), vapor 47.8 R (47.4), TVS flow 0.0518 lbm/hr (0.0522). The vapor-cooled shield and internal HX are carried as solid thermal mass but not resolved as flow paths — their ducts run at NTU ≈ 29 per node, beyond what the segregated solid/fluid coupling can solve; see the module header of [`src/ui/lh2StorageTank.ts`](src/ui/lh2StorageTank.ts) for the full accounting.

---

## Library Usage

The solver core (`src/core`) is a platform-agnostic TypeScript library: it has no DOM, React, or worker dependency and runs unchanged in Node.js, so simulations can be scripted, swept, and checked into research pipelines without the UI. The supported export surface is [`src/core/index.ts`](src/core/index.ts) — `NetworkConfig`, validation, the solver entry points, and the result types.

The package is not yet published to npm, so import from the source tree (as the tools under [`scripts/`](scripts/) do, e.g. `import { solveSteady } from '../src/core'`); once packaged, the same imports become `from 'openflume/core'`. Run scripts with `npx tsx script.ts` (Node ≥ 22.9). `DynamicCheckValve` is currently exported from `src/core/components` rather than the supported core barrel; construct it through `NetworkConfig` like the other components.

### Steady solve

```typescript
import {
  solveSteady,
  validateNetwork,
  decodeNetworkConfig,
} from "openflume/core";
import { readFileSync } from "node:fs";

// Load and validate a network configuration
const config = decodeNetworkConfig(
  JSON.parse(readFileSync("network.json", "utf8")),
);
const errors = validateNetwork(config);
if (errors.length > 0) {
  console.error("Invalid network:", errors);
  process.exit(1);
}

// Solve
const result = solveSteady(config, {
  onProgress: ({ iteration, residual }) =>
    console.log(`Iter ${iteration}: residual = ${residual.toExponential(3)}`),
});

console.log("Converged:", result.converged);
console.log("Iterations:", result.iterations);
console.log(
  "Node pressures:",
  Object.entries(result.nodes).map(([id, n]) => `${id}: ${n.pressure} Pa`),
);
```

### Transient solve

```typescript
import { solveTransient } from "openflume/core";

const result = solveTransient(config, {
  onProgress: ({ time, endTime, dt }) =>
    console.log(`t = ${time.toFixed(3)} / ${endTime} s (dt = ${dt} s)`),
});

console.log("Converged:", result.converged);
console.log("Recorded steps:", result.times.length);
console.log("Tank pressure trace:", result.nodes["tank"].pressure);
```

Transient configs need `settings.endTime` and either a fixed `settings.dt` or `settings.timeStepping: 'adaptive'` with `settings.adaptive` bounds; internal nodes need a positive `volume`. Adaptive runs return accepted/rejected step statistics in `result.stats`. Pass `shouldAbort: () => boolean` to stop a run early — the returned result carries the partial trajectory with `aborted: true`.

### Real fluids (CoolProp sidecar)

Networks using `fluid.model: 'realFluid'` evaluate properties through the `coolprop-wasm` sidecar (~6.5 MB), which must be initialized once before solving:

```typescript
import { initRealFluids, solveSteady } from "openflume/core";

await initRealFluids();
const result = solveSteady(realFluidConfig);
```

Everything else — validation, all analytic fluid models, both solvers, and the `.fn` text format (`src/substrate`) — is pure TypeScript with no external service dependency.

---

## Theory & Governing Equations

### Units

All quantities are **SI**:

- Pressure: Pa
- Temperature: K
- Mass flow: kg/s
- Density: kg/m³
- Viscosity: Pa·s
- Length / diameter: m
- Area: m²
- Volume: m³
- Heat input: W
- Specific heat: J/(kg·K)
- Time: s

### Mass Conservation (Internal Nodes)

For every internal node `i`:

$$\sum_{\text{in}} \dot{m} - \sum_{\text{out}} \dot{m} = 0 \quad \text{(steady)}$$

$$\sum_{\text{in}} \dot{m} - \sum_{\text{out}} \dot{m} + \frac{d}{dt}(\rho_i V_i) = 0 \quad \text{(transient)}$$

### Branch Momentum (Component Pressure-Drop Relations)

Each branch component implements a pressure-drop function $\Delta P(\dot{m}, \rho, \mu, t)$. The sign convention is $\Delta P = P_{\text{from}} - P_{\text{to}}$.

With `settings.momentumFlux: true` the branch momentum equation additionally carries the convective-acceleration (momentum-flux) term

$$\Delta P_{\text{accel}} = \Big(\frac{\dot{m}}{A}\Big)^2 \Big(\frac{1}{\rho_{\text{to}}} - \frac{1}{\rho_{\text{from}}}\Big)$$

evaluated at the branch endpoint states with the component's flow area $A$ (for tapered components, the endpoint's own area — see `pipe.diameterOut` below). It is identically zero for constant-density flow and captures the pressure paid to accelerate a fluid that expands along a branch (heating, decompression) or through an area change. The flag is off by default so published-benchmark baselines are unchanged; branches whose component carries no flow area contribute no term.

#### Compressible duct flow (`settings.kineticEnergy`)

With `settings.kineticEnergy: true` (any fluid model) the energy equation transports **stagnation** enthalpy $h_0 = h + \tfrac{1}{2}v^2$ instead of static enthalpy, and the momentum equation's friction and acceleration terms are evaluated at the resulting static states (friction uses the harmonic mean of the endpoint static densities, the correct integral weighting for accelerating flow). Together with `momentumFlux` this closes the quasi-1-D compressible duct equations: a chain of pipe branches then reproduces Fanno flow (friction choking at $M = 1$), Rayleigh flow (thermal choking), and converging–diverging nozzle flow, including a seeded supersonic bell. In steady mode the solver couples enthalpy into the Newton system alongside pressure and mass flow (`[P, ṁ, h]`), which is what lets it hold the near-sonic exit states — and since enthalpy is a complete state coordinate for every EOS, the same formulation covers CoolProp real fluids. The capability is validated against the NASA TFAWS-2007 GFSSP verification paper (Bandyopadhyay & Majumdar, [NTRS 20070036728](https://ntrs.nasa.gov/api/citations/20070036728/downloads/20070036728.pdf)) in [`src/core/__tests__/compressibleDuctFlow.test.ts`](src/core/__tests__/compressibleDuctFlow.test.ts): all five cases (Fanno, Rayleigh, combined friction + heat, adiabatic nozzle, heated nozzle) match an RK4 integration of the generalized 1-D compressible-flow ODE within the paper's own 5 % agreement, and branch results report the local Mach number. The same cases are written up, figure for figure, in [`docs/validation/compressible-report.md`](docs/validation/compressible-report.md). Real-fluid transonic flow rides the same formulation: a CoolProp nitrogen choked CD nozzle ([`src/core/__tests__/realFluidTransonic.test.ts`](src/core/__tests__/realFluidTransonic.test.ts)) matches an analytic ideal-gas twin on mass flow to 0.17% and converges from a flat cold start. Under the default `momentumFluxScheme: "upwind"` transonic solves are seed-robust (choked flow lands a few percent high, the scheme's first-order sonic-cell bias); the `"central"` scheme is tighter (<1%) but, like GFSSP, needs reasonable initial guesses (`branches[].initialMdot`, node P/T seeds). Both benefit from grids clustered near the choke point.

> **Validity — no shock capture.** A smoothly expanding supersonic branch is reachable when it is seeded (`initialMdot` plus supersonic node P/T), as in the shipped LOX/RP-1 thruster, which crosses $M = 1$ at the throat and runs supersonic down the bell. What is missing is any Rankine–Hugoniot jump condition: shock position, over-expanded/separated nozzle operation, and any supersonic → subsonic transition are out of scope, as is thrust. Without `kineticEnergy`, the formulation carries no Mach number: pipe friction has no Fanno-flow treatment and choking is modeled only as the point closures in `orificeCompressible` and `cavitatingVenturi`. See [Current Limitations](#current-limitations).

#### Pipe (Darcy–Weisbach)

$$\Delta P_{\text{friction}} = f \frac{L}{D} \frac{\rho v |v|}{2}, \qquad v = \frac{\dot{m}}{\rho A}$$

- **Laminar** ($Re < 2300$): $f = 64 / Re$
- **Turbulent** ($Re \ge 2300$): Swamee–Jain explicit approximation
  $$f = 0.25 \Big/ \log_{10}\Big(\frac{\varepsilon}{3.7 D} + \frac{5.74}{Re^{0.9}}\Big)^2$$
- **Transition** ($2000 \le Re < 4000$): linear blend between laminar and turbulent values.
- **Elevation**: $\Delta P_{\text{elev}} = \rho g \Delta z$ added algebraically.
- **Fixed friction factor**: `pipe.frictionFactor` overrides the correlations with a constant Darcy $f$ (0 gives a frictionless pipe) — useful for textbook cases and codes-to-codes comparison where $f$ is prescribed.
- **Taper**: `pipe.diameterOut` makes the segment linearly tapered from `diameter` to `diameterOut`; friction uses the mean flow area and, with `momentumFlux`, each endpoint contributes its own area to the acceleration term. A chain of tapered pipes models a converging–diverging nozzle.

#### Orifice

$$\Delta P = \frac{\dot{m} |\dot{m}|}{2 \rho (C_d A)^2}$$

#### Flow Resistance (K-factor)

$$\Delta P = \frac{K  \dot{m} |\dot{m}|}{2 \rho A^2}$$

#### Valve

Effective discharge area scales with position $p(t)$ (optionally driven by a schedule):

$$\Delta P = \frac{\dot{m} |\dot{m}|}{2 \rho (C_d A  p_{\text{eff}})^2}, \qquad p_{\text{eff}} = \max(p \cdot C_d A, 10^{-9})$$

At $p = 0$ a floor area keeps the Jacobian non-singular.

#### Check Valve

Forward flow behaves as an orifice. Reverse flow is blocked via a smooth huge resistance:

$$\Delta P = C  \dot{m} |\dot{m}| + R(\dot{m})  \dot{m}$$

where $C = 1 / (2 \rho C_d^2 A^2)$ and $R(\dot{m}) = R_0 (1 - s)$ with $s = 0.5[1 + \tanh(\dot{m}/\varepsilon)]$, $R_0 = 10^{11}$, $\varepsilon = 10^{-3}$.

#### Pump

Pressure **rise** (negative pressure drop) is interpolated from a $(Q, \Delta P_{\text{rise}})$ curve, where $Q = \dot{m} / \rho$:

$$\Delta P_{\text{pump}} = -\text{interp}(Q)$$

#### Bend

Idelchik/Crane-style K-factor plus arc friction:

$$K_{\text{bend}} = K_{90} \left(\frac{\theta}{90}\right)^{0.85}, \qquad K_{\text{arc}} = f \frac{L_{\text{arc}}}{D}, \qquad \Delta P = \frac{(K_{\text{bend}} + K_{\text{arc}})  \dot{m} |\dot{m}|}{2 \rho A^2}$$

#### Area Change

Borda–Carnot sudden expansion; empirical contraction coefficient for sudden contraction. Direction-aware (reversed flow swaps inlet/outlet roles):

$$\text{Exp: } K = \left(1 - \frac{A_{\text{in}}}{A_{\text{out}}}\right)^2, \qquad \text{Con: } K = 0.5\left(1 - \frac{A_{\text{out}}}{A_{\text{in}}}\right)^{0.75}, \qquad \Delta P = \frac{K  \dot{m} |\dot{m}|}{2 \rho A_{\text{ref}}^2}$$

#### Flow Source

Imposes a specified mass-flow rate regardless of $\Delta P$:

$$\dot{m} = \dot{m}_{\text{set}}(t)$$

#### Regulator

Holds downstream pressure at a set-point using a smooth minimum (softmin) between the set pressure and an orifice-like upstream pressure drop:

$$P_{\text{down}} - \text{softmin}\big(P_{\text{set}},  P_{\text{up}} - \Delta P_{\text{orifice}}(\dot{m})\big) = 0$$

#### Relief Valve

Closed below crack pressure, linear opening to full-open pressure, plus smooth check-valve reverse blocking:

$$\text{CdA}*{\text{eff}} = \text{Cd}A \cdot \text{smoothstep}(P*{\text{crack}}, P_{\text{full}}, \Delta P), \qquad \Delta P = \frac{\dot{m}|\dot{m}|}{2 \rho  \text{CdA}_{\text{eff}}^2} + R(\dot{m})\dot{m}$$

#### Orifice Compressible

Isentropic ideal-gas orifice with choking. Mass flux function $M(P_r, \gamma)$ automatically transitions to the choked limit at the critical pressure ratio:

$$\dot{m} = C_d A  P_{\text{up}} \sqrt{\frac{\gamma}{R T_{\text{up}}}}  M(P_r, \gamma)$$

#### Cavitating Venturi

Analytical choked-flow closure for real fluids. Two regimes with a smooth `tanh` blend:

1. **Choked (cavitating)** — when the throat pressure drops to the fluid saturation pressure $P_v(T_{\text{up}})$:
   $$\dot{m}*{\text{choked}} = C_d A \sqrt{2 \rho \big(P*{\text{up}} - P_v\big)}$$
   This branch is **independent of downstream pressure**; the diffuser recovers pressure from $P_v$ back to $P_{\text{down}}$.
2. **Non-choked (subcooled)** — at small overall $\Delta P$ the throat never reaches $P_v$ and the component behaves as a standard incompressible orifice:
   $$\dot{m}*{\text{unchoked}} = C_d A \sqrt{2 \rho \big(P*{\text{up}} - P_{\text{down}}\big)}$$

The transition is governed by a **recovery factor** $r$ (default `0.0`, tuneable via `recoveryFactor`). $r = 0$ means no diffuser recovery (throat pressure equals downstream pressure, legacy simple-orifice behaviour). $r > 0$ raises the critical downstream pressure at which cavitation onset occurs:

$$P_{\text{crit}} = r  P_{\text{up}} + (1-r)  P_v$$

Blend:
$$\text{blend} = \tfrac{1}{2}\big[1 + \tanh\big(100  (P_{\text{crit}} - P_{\text{down}}) / (P_{\text{up}} - P_v)\big)\big]$$

_Requires_ `realFluid` _fluid model._ Validation rejects the component for non-real fluids because $P_v$ is needed.

#### Heated Pipe

Identical hydraulics to `pipe` plus convective heat transfer in effectiveness-NTU form:

$$Q = \dot{m} c_p  \varepsilon  (T_{\text{wall}} - T_{\text{in}}), \qquad \varepsilon = 1 - \exp\left(-\frac{UA}{\dot{m} c_p}\right)$$

Branch heat is fed into the downstream node energy balance.

### Energy Equation

For each internal node:

**Steady** – upwinded enthalpy balance (no storage):

$$\sum_{\text{in}} \dot{m} h_{\text{upwind}} - \sum_{\text{out}} \dot{m} h_{\text{node}} + \dot{Q}_{\text{in}} = 0 \quad \text{(steady)}$$

**Transient** – internal-energy storage with enthalpy flux:

$$\frac{d}{dt}(m  u) = \sum_{\text{in}} \dot{m} h_{\text{upwind}} - \sum_{\text{out}} \dot{m} h_{\text{node}} + \dot{Q}_{\text{in}} \quad \text{(transient)}$$

By default both forms flux **static** enthalpy: the kinetic-energy term $\tfrac{1}{2}v^2$ is not carried, so there is no stagnation/static distinction and velocity-head-to-temperature conversion is not modeled. With `settings.kineticEnergy: true` (any fluid model) the flux becomes **stagnation** enthalpy $h_0 = h + \tfrac{1}{2}v^2$, recovering static-temperature drop in accelerating ducts and adiabatic $T_0$ conservation — see [Compressible duct flow](#compressible-duct-flow-settingskineticenergy).

Here $m = \rho V$ is the nodal fluid mass, $u = c_v T$ is specific internal energy, and $h = c_p T$ is specific enthalpy. This formulation correctly captures the flow-work difference: for ideal gases $c_p - c_v = R$, giving adiabatic blowdown cooling ($T \propto m^{\gamma-1}$) and adiabatic fill heating (approaching $\gamma  T_{\text{supply}}$). For incompressible and expandable liquids $c_v = c_p$, so the behaviour is unchanged from the prior $c_p$-form because $dm/dt \approx 0$. For real fluids, $h(P,T)$ and $u(P,T)$ are evaluated directly from CoolProp, giving true non-ideal-gas adiabatic cooling (e.g., N₂ blowdown at 10 MPa drops >20 K).

**Isothermal tank modeling** – to enforce a near-isothermal gas tank, add a solid ambient node and a very large convection conductor between the tank node and the ambient node (e.g., $hA \gg 10^4$ W/K). The conjugate thermal subsystem will then hold the tank temperature within $\sim$1 K of the ambient set-point.

### Solid Energy Balance (Conjugate Heat Transfer)

For each solid node:

$$\sum_{\text{connected conductors}} \dot{Q} + \dot{Q}_{\text{src}} = 0 \quad \text{(steady)}$$

$$\sum_{\text{connected conductors}} \dot{Q} + \dot{Q}_{\text{src}} + m c_p \frac{dT}{dt} = 0 \quad \text{(transient)}$$

#### Conductor Laws

- **Conduction**: $Q = \frac{k A}{L}  (T_{\text{from}} - T_{\text{to}})$
- **Convection**: $Q = h A  (T_{\text{solid}} - T_{\text{fluid}})$
- **Radiation**: $Q = \varepsilon \sigma A F  (T_{\text{from}}^4 - T_{\text{to}}^4)$

The thermal subsystem is solved with Newton–Raphson. Radiation contributes an exact Jacobian entry $\partial Q / \partial T = 4 \varepsilon \sigma A F T^3$ for robust convergence. Convection between fluid and solid nodes is coupled implicitly: the fluid node temperature residual includes the conductor heat rate, and the solid node residual includes the same term with opposite sign.

#### Correlation-based Convection (opt-in)

The `convection` conductor can optionally compute $h$ from the local fluid state instead of using a constant value. This is **backward-compatible**: omitting `correlation` keeps the legacy constant-$h$ behaviour unchanged.

```json
{
  "kind": "convection",
  "area": 0.01,
  "correlation": {
    "model": "dittusBoelter",
    "diameter": 0.03,
    "flowArea": 7.07e-4
  }
}
```

- `h` becomes optional when `correlation` is present. If absent, a small fallback floor $h_{\min}=5\text{W/m}^2\text{K}$ is applied to avoid a zero conductance.
- `correlation` requires `realFluid` (validated pre-solve) — except `model: "custom"`, which works on any fluid model when the expression uses only generic quantities.
- `diameter` must be positive. `flowArea` defaults to $\pi D^2/4$ when omitted. Both are formula-bindable (`{ "expr": "pipe('seg1').diameter" }`).
- `model` selects `"dittusBoelter"`, `"miropolskii"`, `"darrHartwig"` (needs `axialPosition`), `"ttWf"` (needs `axialPosition` + `segmentLength`, transient only), or `"custom"` (needs `expression`, optional `params`). The property panel exposes the per-model inputs with suitability warnings; `"custom"` is not a menu entry there — it is what the **Specified h** box stores when you type an equation over the local flow state. See [`docs/parameter-bindings.md`](docs/parameter-bindings.md).

**Mass-flux convention.** The fluid-node mass flux is
$$G = \frac{\dot{m}*{\text{node}}}{A*{\text{flow}}}, \qquad \dot{m}*{\text{node}} = \frac{1}{2}\sum*{\text{attached branches}} |\dot{m}|.$$
This matches the GFSSP convention where conductors are tied to nodes.

**Dittus–Boelter** (single-phase turbulent forced convection, Dittus & Boelter 1930):
$$\text{Nu} = 0.023\text{Re}^{0.8}\text{Pr}^{0.4}, \qquad h = \frac{\text{Nu}k}{D}.$$
The exponent $0.4$ is used uniformly (heating). For $\text{Re}<2300$ the laminar limit $\text{Nu}=3.66$ is used with a smooth linear blend between $\text{Re}=2000$ and $4000$.

**Miropolskii** (film boiling, two-phase upstream; Miropolskii 1963 via Cross, Majumdar _et al._, _J. Spacecraft & Rockets_ 2002):
$$\text{Nu} = 0.023\bigl[\text{Re}_g(x + \tfrac{\rho_g}{\rho_f}(1-x))\bigr]^{0.8}\text{Pr}_g^{0.4}Y,$$
$$Y = 1 - 0.1(\tfrac{\rho_f}{\rho_g}-1)^{0.4}(1-x)^{0.4}, \qquad h = \frac{\text{Nu}k_g}{D},$$
with $\text{Re}_g = G D/\mu_g$ and vapor properties ($\mu_g$, $k_g$, $\text{Pr}_g$) evaluated at saturation. Quality is clamped to $[0.01,0.99]$ inside the formula for stability at the dome edges. When the node is single-phase the Miropolskii model **falls back to Dittus–Boelter** on that state, making it usable across a chilldown where nodes pass through the dome.

The solver recomputes $h$ each outer iteration from the current node state (pressure, enthalpy/temperature, quality, branch mass flows). To avoid instability from $h$ jumping between iterations, the effective value is under-relaxed by a factor of 0.5 across outer loops. The resulting $h$ is exposed in both steady and transient results as `heatTransferCoeff`.

### Equations of State

- **Incompressible liquid** – $\rho = \text{const}$, $\mu = \text{const}$, $h = c_p T$
- **Ideal gas** – $\rho = P / (R T)$, $\mu = \text{const}$, $h = c_p T$. Custom `R`, `gamma`, `mu`, `cp` allow modeling helium, CO₂, etc.
- **Expandable liquid** – $\rho(T) = \rho_0 \bigl[1 - \beta (T - T_0)\bigr]$, $\mu = \text{const}$, $h = c_p T$. The `waterExpandable` preset uses $\rho_0 = 998$, $\beta = 2.07\times10^{-4}$, $T_0 = 293$ K.
- **Real fluid (CoolProp)** – NIST-grade $\rho(P,T)$, $\mu(P,T)$, $c_p(P,T)$, $c_v(P,T)$, $h(P,T)$, $u(P,T)$ via CoolProp WASM. The generated HEOS catalogue covers 124 fluids; the picker favorites are Nitrogen, Oxygen, Hydrogen, ParaHydrogen, Helium, Methane, Carbon Dioxide, Water, and NitrousOxide. The energy equation uses true enthalpy and internal energy rather than ideal-gas approximations. See [`docs/fluid-catalogue.md`](docs/fluid-catalogue.md).

For branches with elevation change, the solver averages upstream and downstream density when computing the elevation head. This is essential for natural-circulation loops with thermally expanding liquids.

A network has a required default `fluid` plus optional named extras in `fluids`. A node owns its fluid (`nodes[].fluid` names an extra, or omitted means the default); a branch inherits from its endpoints and may connect two nodes only when they resolve to the **same** named fluid. Unlike fluids do not mix at a junction — the only allowed coupling is heat through solids (convection on opposite sides of a wall). EOS **classes** may differ between continua (e.g. an `idealGas` hot side with a `realFluid` coolant): since unlike fluids never share an equation, the solver dispatches property access per node. Species transport stays a composition within one ideal gas and is rejected when named fluids are present.

### Transient Momentum & Gas Cushion

#### Fluid Inertia

For pipe branches the transient momentum equation can include the unsteady inertia term:

$$\Delta P = \Delta P_{\text{friction}} + \frac{L}{A} \frac{d\dot{m}}{dt}$$

Enable it by setting `inertia: true` on a `pipe` component. This stores kinetic energy in the fluid column and couples pressure changes to mass-flow acceleration. **When to enable:** use `inertia: true` whenever you expect transient mass-flow rates to change significantly within a single time step (e.g. rapid valve closure, pump trip, or entrapped-air compression). For slow thermal transients (minutes to hours) the quasi-steady default (`inertia: false`) is sufficient and cheaper.

Note that this lumped term captures bulk surge only. There is no distributed wave equation, so acoustic pressure-wave propagation and reflection (classical water hammer) are not modeled — see [Current Limitations](#current-limitations).

#### Trapped-Gas Cushion

An internal node may carry a `gasCushion`:

$$P  V_g^{n} = \text{const}, \qquad V_g = V_{\text{total}} - V_w$$

where $V_{\text{total}}$ is the fixed node volume, $V_w$ is the incompressible water volume, and $n$ is the polytropic index (typically $1.0 \le n \le 1.4$). The gas volume is derived from the solved node pressure at every time step, and the water volume change supplies the mass-storage term in the node mass balance. **When to enable:** use `gasCushion` only for **incompressible liquid** networks in **transient** mode (the solver validates this pre-run). It models entrapped air at the end of a pipe run, liquid-filled accumulators, or cushion chambers.

---

## Solution Methods

### Steady State – Coupled Newton–Raphson

1. **Unknowns** – pressure at every internal node; mass flow in every branch.
2. **Residuals**

- Mass residual at each internal node: $\sum \dot{m}*{\text{in}} - \sum \dot{m}*{\text{out}} = 0$
- Momentum residual for each branch: $P_{\text{from}} - P_{\text{to}} - \Delta P_{\text{component}}(\dot{m}) - \Delta P_{\text{accel}} = 0$ (the acceleration term only with `settings.momentumFlux`)

3. **Jacobian** – by default a **hybrid AD / FD Jacobian**. Where every code path that contributes to a column is authored in TypeScript (analytic fluid models: `incompressible`, `idealGas`, `expandableLiquid`; component pressure-drop relations with dual implementations: `pipe`, `orifice`, `resistance`, `valve`, `bend`, `areaChange`, `checkValve`, `dynamicCheckValve`), the derivative is computed **exactly** with forward-mode dual numbers in a single residual evaluation per column. `dynamicCheckValve`'s ODE state (`position`) is frozen for the whole Newton solve, so its dual is exact with respect to ṁ exactly like a fixed-position `valve`. Real-fluid (`realFluid`) networks are also analytic: `RealFluid.derivativesPH` provides ∂(ρ, T)/∂(P, h) once per node per Jacobian build (single-phase via CoolProp `first_partial_deriv`; in-dome via saturation-curve derivatives differentiated through the solver's HEM mixture rules — CoolProp's own in-dome partials use a different two-phase convention and are not used), and every column chains those cached partials, so CoolProp calls per Jacobian build are O(nodes) rather than O(nodes × columns). Finite differences remain only where the residual is genuinely non-differentiable — components without a dual implementation (`pump`, `regulator`, `reliefValve`, `orificeCompressible`, `cavitatingVenturi`) and `heatedPipe` branch heat get per-entry FD patches — and the whole matrix falls back to FD for unsupported configurations (species transport, real-fluid gas cushions). The pure-FD path remains available via `settings.jacobian: 'fd'`.
4. **Linear solve** – dense Gaussian elimination on the coupled system.
5. **Update** – $\mathbf{x}_{n+1} = \mathbf{x}_n + \omega  \mathbf{J}^{-1} \mathbf{R}$ with under-relaxation $\omega$ (default 0.9).
6. **Zero-flow linearization** – for $|\dot{m}| < 10^{-7}$ the branch $\Delta P$ is linearized around the threshold to avoid singular Jacobians.
7. **Convergence** – when $\mathbf{R}_\infty < \text{tolerance}$ (default $10^{-9}$).
8. **Globalization & PTC (real-fluid)** – for real-fluid steady and transient solves the default inner-loop globalization is a **trust-region dogleg** method operating in the scaled variable space (`sX`/`sR`). It computes the full Newton step, the Cauchy point, and the dogleg segment intersection, accepting steps based on the ared/pred ratio. Radius grows when agreement is strong and shrinks when it is poor; at most 2 retries per inner iteration. If dogleg fails completely, the solver falls back to the legacy backtracking line search. For real-fluid steady solves, **PTC regularisation** is layered on top: the direct Newton step is attempted first; only when the globalization rejects it does the solver fall back to a strongly regularised pseudo-transient step (`J_scaled[i][i] += 1/δτ` for rows whose scaled diagonal is below unity). Switched-evolution-relaxation grows `δτ` as the residual drops, recovering exact Newton at convergence. Non-real-fluid problems always use the direct step with legacy line-search acceptance. Users can force the legacy path everywhere by setting `settings.globalization: 'lineSearch'`.

### Transient – Backward Euler (Fixed or Adaptive)

1. **Time marching** – from $t = 0$ to $t = t_{\text{end}}$.

- **Fixed step** – uniform $\Delta t$ as specified by `settings.dt`.
- **Adaptive step** – step-doubling local error control. Each candidate step performs one full backward-Euler step of size $\Delta t$ (yielding $y_1$) and two consecutive steps of $\Delta t/2$ (yielding $y_2$). The weighted RMS error norm is computed over all internal-node pressures and temperatures (fluid and solid):
  $$\text{err} = \sqrt{\frac{1}{N}\sum \left(\frac{y_2 - y_1}{\text{absTol} + \text{relTol}|y_2|}\right)^2}$$
  The step is accepted when $\text{err} \le 1$, and the next step size is set via
  $$\Delta t_{\text{new}} = \Delta t \cdot \text{clamp}\big(0.9 \cdot \text{err}^{-1/2}, 0.2, 5\big),$$
  clamped to `[dtMin, dtMax]`. On rejection the step is retried with the reduced size; if `dtMin` is reached the step is forcibly accepted and a warning is recorded in `stats.dtAtMinCount`. Event alignment truncates `dt` so that every accepted step lands exactly on schedule breakpoints and on `endTime`.

2. **At each step**

- Apply boundary schedules (pressure, temperature, valve position).
- Solve a steady-like coupled Newton–Raphson step with storage terms added to the mass residual:
  $$R_{\text{mass},i} = \sum \dot{m} + \frac{(\rho_i^{n+1} - \rho_i^n) V_i}{\Delta t}$$
- Energy residual uses internal-energy storage:
  $$\frac{(m^{n+1} c_v T^{n+1} - m^n c_v T^n)}{\Delta t} = \sum_{\text{in}} \dot{m} c_p T_{\text{upwind}} - \sum_{\text{out}} \dot{m} c_p T^{n+1} + \dot{Q}_{\text{in}}$$
  solved implicitly for $T^{n+1}$ via successive substitution after the mass-flow field has converged.

3. **Store** the converged state and advance to the next time level.
4. **Result** – time arrays for every node and branch variable. Adaptive runs include `stats: { steps, rejectedSteps, minDt, maxDt, dtAtMinCount }`. Progress emissions report `time / endTime` and current `dt` instead of a fixed step counter.

---

## Config File Format (JSON Schema)

A complete network is a single `NetworkConfig` JSON object. Below is an annotated example of the **"Three-pipe junction"** steady case.

```json
{
  "meta": {
    "name": "Three-pipe junction",
    "version": 2
  },
  "settings": {
    "mode": "steady",
    "tolerance": 1e-9,
    "maxIterations": 500,
    "relaxation": 0.9
  },
  "fluid": {
    "model": "incompressible",
    "preset": "water"
  },
  "nodes": [
    {
      "id": "in",
      "type": "boundary",
      "x": 0,
      "y": 0,
      "pressure": 300000,
      "temperature": 300,
      "label": "Inlet"
    },
    {
      "id": "j",
      "type": "internal",
      "x": 200,
      "y": 0,
      "pressure": 250000,
      "temperature": 300,
      "label": "Junction",
      "volume": 0.001
    },
    {
      "id": "out1",
      "type": "boundary",
      "x": 400,
      "y": 100,
      "pressure": 200000,
      "temperature": 300,
      "label": "Out 1"
    }
  ],
  "branches": [
    {
      "id": "b1",
      "from": "in",
      "to": "j",
      "label": "Pipe 1",
      "component": {
        "type": "pipe",
        "length": 2,
        "diameter": 0.03,
        "roughness": 1e-5,
        "elevationChange": 0
      }
    },
    {
      "id": "b2",
      "from": "j",
      "to": "out1",
      "label": "Pipe 2",
      "component": {
        "type": "pipe",
        "length": 3,
        "diameter": 0.02,
        "roughness": 1e-5
      }
    }
  ]
}
```

### Field Reference

| Field                                 | Type                                                    | Required                 | Description                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meta.name`                           | string                                                  | yes                      | Human-readable network name                                                                                                                                                                                                                                                                                                          |
| `meta.version`                        | `2`                                                     | yes                      | Schema version (must be `2`)                                                                                                                                                                                                                                                                                                         |
| `settings.mode`                       | `"steady"`                                              | `"transient"`            | yes                                                                                                                                                                                                                                                                                                                                  | Solver mode                                                                                                  |
| `settings.tolerance`                  | number                                                  | yes                      | Convergence tolerance                                                                                                                                                                                                                                                                                                                |
| `settings.maxIterations`              | number                                                  | yes                      | Max Newton iterations                                                                                                                                                                                                                                                                                                                |
| `settings.relaxation`                 | number                                                  | no                       | Under-relaxation factor (0–1)                                                                                                                                                                                                                                                                                                        |
| `settings.steadySolver`               | `"ptc"`                                                 | `"direct"`               | no                                                                                                                                                                                                                                                                                                                                   | Real-fluid steady solver strategy (default `ptc`)                                                            |
| `settings.globalization`              | `"trustRegion"`                                         | `"lineSearch"`           | no                                                                                                                                                                                                                                                                                                                                   | Inner-loop globalization strategy. Default is `trustRegion` for real-fluid, `lineSearch` for everything else |
| `settings.dt`                         | number                                                  | transient                | Fixed time step                                                                                                                                                                                                                                                                                                                      |
| `settings.endTime`                    | number                                                  | transient                | Final simulation time                                                                                                                                                                                                                                                                                                                |
| `settings.timeStepping`               | `"fixed"`                                               | `"adaptive"`             | no                                                                                                                                                                                                                                                                                                                                   | Time-stepping mode (default `fixed`)                                                                         |
| `settings.adaptive.dtMin`             | number                                                  | adaptive                 | Minimum step size                                                                                                                                                                                                                                                                                                                    |
| `settings.adaptive.dtMax`             | number                                                  | adaptive                 | Maximum step size                                                                                                                                                                                                                                                                                                                    |
| `settings.adaptive.relTol`            | number                                                  | adaptive                 | Relative tolerance for error norm                                                                                                                                                                                                                                                                                                    |
| `settings.adaptive.absTolP`           | number                                                  | no                       | Absolute pressure tolerance (default 100 Pa)                                                                                                                                                                                                                                                                                         |
| `settings.adaptive.absTolT`           | number                                                  | no                       | Absolute temperature tolerance (default 0.01 K)                                                                                                                                                                                                                                                                                      |
| `settings.adaptive.safety`            | number                                                  | no                       | Safety factor (default 0.9)                                                                                                                                                                                                                                                                                                          |
| `settings.adaptive.dtInitial`         | number                                                  | no                       | Initial guess for the first step                                                                                                                                                                                                                                                                                                     |
| `settings.gravity`                    | `{ x, y, z }`                                           | no                       | Gravity vector [m/s²]; default `{0, 0, −9.80665}` (z-up). Hydrostatics currently still use `elevationChange × 9.80665`.                                                                                                                                                                                                              |
| `settings.momentumFlux`               | boolean                                                 | no                       | Include the momentum-flux (convective acceleration) term `(ṁ/A)²·(1/ρ_dn − 1/ρ_up)` in branch momentum. Default off; identically zero for constant-density flow. Branches without a component flow area contribute no term.                                                                                                          |
| `settings.kineticEnergy`              | boolean                                                 | no                       | Transport stagnation enthalpy `h + v²/2` in the energy equation (any fluid model; species networks keep the segregated update). With `momentumFlux`, enables quasi-1-D compressible duct flow (Fanno/Rayleigh choking, nozzles). Default off.                                                                                        |
| `settings.momentumFluxScheme`         | `"upwind"` / `"central"`                                | no                       | Face scheme for the momentum-flux term on compressible branches (ideal gas always; real fluid when `kineticEnergy` is on). Default `"upwind"`: limited-upwind faces, seed-robust transonic solves, choked flow a few percent high. `"central"`: exact endpoint form, <1% choked accuracy, needs a warm start on the physical branch. |
| `settings.transonicAdmissibility`     | boolean                                                 | no                       | Second-law audit + re-seed for central-scheme transonic roots (default on; no effect unless `momentumFlux` is on with `"central"` and an ideal-gas branch exists). Unresolved violations are reported in `SteadyResult.warnings`.                                                                                                    |
| `settings.certifyAfterCoupling`       | boolean                                                 | no                       | Experimental (default off): certify transient real-fluid steps on the post-coupling residual. See [`docs/solver-convergence.md`](docs/solver-convergence.md).                                                                                                                                                                        |
| `fluid.model`                         | `"incompressible"`                                      | `"idealGas"`             | `"expandableLiquid"`                                                                                                                                                                                                                                                                                                                 | `"realFluid"`                                                                                                | yes                                                                                                                                                                                                       | EOS model      |
| `fluid.preset`                        | `"water"`                                               | `"air"`                  | `"waterExpandable"`                                                                                                                                                                                                                                                                                                                  | no                                                                                                           | Quick-select preset (not used for `realFluid`)                                                                                                                                                            |
| `fluid.params`                        | object                                                  | no                       | Custom `rho`, `mu`, `cp`, `R`, `gamma`, `rho0`, `beta`, `T0`, or `fluidName` for real fluids                                                                                                                                                                                                                                         |
| `fluids`                              | `{ [name]: FluidSpec }`                                 | no                       | Named extra fluids (isolated continua). EOS classes may differ between entries (unlike fluids couple only through solid walls).                                                                                                                                                                                                      |
| `componentLibrary`                    | object                                                  | no                       | Embedded trusted component source keyed by branch reference; entry has `code`, optional `format` (`defineComponent` or `inline`), and optional `description`                                                                                                                                                                         |
| `registers`                           | `{ [name]: number }`                                    | no                       | Initial numeric values for lifecycle expressions; final values are returned in results                                                                                                                                                                                                                                               |
| `logic`                               | `LogicRule[]`                                           | no                       | Event rules with `id`, optional `on`, `when`, optional atomic `set`, `stop`, and `reason`                                                                                                                                                                                                                                            |
| `controllers`                         | `ControllerConfig[]`                                    | no                       | Transient PID controllers; execute after accepted steps and actuate the next step                                                                                                                                                                                                                                                    |
| `species`                             | `SpeciesConfig`                                         | no                       | Species transport + reacting flow (opt-in; `idealGas` only)                                                                                                                                                                                                                                                                          |
| `species.names`                       | `string[]`                                              | yes                      | Ordered species identifiers                                                                                                                                                                                                                                                                                                          |
| `species.molecularWeights`            | `number[]`                                              | yes                      | Molecular weights (kg/mol), aligned with `names`                                                                                                                                                                                                                                                                                     |
| `species.cp`                          | `number[]`                                              | no                       | Constant-pressure specific heats (J/(kg·K)), aligned with `names`                                                                                                                                                                                                                                                                    |
| `species.formationEnthalpy`           | `number[]`                                              | no                       | Formation enthalpies (J/kg), aligned with `names`                                                                                                                                                                                                                                                                                    |
| `species.viscosity`                   | `number[]`                                              | no                       | Dynamic viscosities (Pa·s), aligned with `names`                                                                                                                                                                                                                                                                                     |
| `species.reactions[]`                 | `ArrheniusReaction[]`                                   | no                       | Chemistry reactions                                                                                                                                                                                                                                                                                                                  |
| `species.reactions[].reactants`       | `{ [speciesName]: number }`                             | yes                      | Reactant stoichiometric coefficients                                                                                                                                                                                                                                                                                                 |
| `species.reactions[].products`        | `{ [speciesName]: number }`                             | yes                      | Product stoichiometric coefficients                                                                                                                                                                                                                                                                                                  |
| `species.reactions[].A`               | number                                                  | yes                      | Arrhenius pre-exponential factor                                                                                                                                                                                                                                                                                                     |
| `species.reactions[].b`               | number                                                  | yes                      | Arrhenius temperature exponent                                                                                                                                                                                                                                                                                                       |
| `species.reactions[].Ea`              | number                                                  | yes                      | Activation energy (J/mol)                                                                                                                                                                                                                                                                                                            |
| `species.reactions[].heatOfReaction`  | number                                                  | no                       | Enthalpy change (J/kg of mixture)                                                                                                                                                                                                                                                                                                    |
| `nodes[].id`                          | string                                                  | yes                      | Unique node identifier                                                                                                                                                                                                                                                                                                               |
| `nodes[].type`                        | `"internal"`                                            | `"boundary"`             | yes                                                                                                                                                                                                                                                                                                                                  | Node type                                                                                                    |
| `nodes[].x`, `y`                      | number                                                  | yes                      | Canvas coordinates (px); never solver input                                                                                                                                                                                                                                                                                          |
| `nodes[].position`                    | `{ x?, y?, z? }` (number or `{ expr }` per axis)        | no                       | Formula-bindable physical coordinates [m], z-up. Unset pipe `elevationChange` and convection `axialPosition` / `segmentLength` are derived from the resolved coordinates on a unique pipe path. Decode still accepts legacy `nodes[].z` as `position.z`.                                                                             |
| `nodes[].group`                       | string                                                  | no                       | Subnetwork group id                                                                                                                                                                                                                                                                                                                  |
| `nodes[].fluid`                       | string                                                  | no                       | Named fluid from `fluids`; omit to use the network default                                                                                                                                                                                                                                                                           |
| `nodes[].pressure`                    | number                                                  | boundary                 | Fixed boundary pressure (Pa)                                                                                                                                                                                                                                                                                                         |
| `nodes[].temperature`                 | number                                                  | boundary / internal init | Temperature (K)                                                                                                                                                                                                                                                                                                                      |
| `nodes[].volume`                      | number or `{ "expr": string }`                          | transient                | Node volume (m³); formula-bindable — see [`docs/parameter-bindings.md`](docs/parameter-bindings.md)                                                                                                                                                                                                                                  |
| `nodes[].heatInput`                   | number                                                  | no                       | Heat addition rate (W)                                                                                                                                                                                                                                                                                                               |
| `nodes[].pressureSchedule`            | `[[t, P], ...]`                                         | no                       | Time-varying boundary pressure                                                                                                                                                                                                                                                                                                       |
| `nodes[].temperatureSchedule`         | `[[t, T], ...]`                                         | no                       | Time-varying boundary temperature                                                                                                                                                                                                                                                                                                    |
| `nodes[].gasCushion`                  | `{ initialGasVolume: number, polytropicIndex: number }` | no                       | Trapped gas cushion for incompressible-liquid transient internal nodes                                                                                                                                                                                                                                                               |
| `nodes[].massFractions`               | `{ [speciesName]: number }`                             | no                       | Per-node species mass fractions for boundaries and internal-node initial state                                                                                                                                                                                                                                                       |
| `groups[].id`                         | string                                                  | yes                      | Subnetwork group identifier                                                                                                                                                                                                                                                                                                          |
| `groups[].label`                      | string                                                  | yes                      | Group display name                                                                                                                                                                                                                                                                                                                   |
| `groups[].x`, `y`                     | number                                                  | yes                      | Group canvas position (px)                                                                                                                                                                                                                                                                                                           |
| `notes[].id`                          | string                                                  | yes                      | Unique note identifier (own namespace — never collides with node ids)                                                                                                                                                                                                                                                                |
| `notes[].text`                        | string                                                  | yes                      | Annotation body; may contain newlines                                                                                                                                                                                                                                                                                                |
| `notes[].x`, `y`                      | number                                                  | yes                      | Note card top-left canvas position (px)                                                                                                                                                                                                                                                                                              |
| `notes[].width`, `height`             | number                                                  | no                       | Explicit card size (px), written when the note is resized; absent means fit the text                                                                                                                                                                                                                                                 |
| `notes[].group`                       | string                                                  | no                       | Subnetwork the note is pinned inside (absent = main canvas)                                                                                                                                                                                                                                                                          |
| `branches[].id`                       | string                                                  | yes                      | Unique branch identifier                                                                                                                                                                                                                                                                                                             |
| `branches[].from`, `to`               | string                                                  | yes                      | Connected node ids                                                                                                                                                                                                                                                                                                                   |
| `solidNodes[].id`                     | string                                                  | yes                      | Unique solid/ambient node identifier (shares namespace with fluid nodes)                                                                                                                                                                                                                                                             |
| `solidNodes[].type`                   | `"solid"`                                               | `"ambient"`              | yes                                                                                                                                                                                                                                                                                                                                  | Solid lumped-mass node or fixed-temperature ambient node                                                     |
| `solidNodes[].x`, `y`                 | number                                                  | yes                      | Canvas coordinates (px); never solver input                                                                                                                                                                                                                                                                                          |
| `solidNodes[].position`               | `{ x?, y?, z? }` (number or `{ expr }` per axis)        | no                       | Formula-bindable physical coordinates [m], z-up; resolved before deriving convection stations                                                                                                                                                                                                                                        |
| `solidNodes[].temperature`            | number                                                  | yes                      | Initial/fixed temperature (K)                                                                                                                                                                                                                                                                                                        |
| `solidNodes[].mass`                   | number                                                  | transient                | Lumped mass (kg)                                                                                                                                                                                                                                                                                                                     |
| `solidNodes[].cp`                     | number or spec object                                   | transient                | Specific heat (J/(kg·K)): constant, `{ material }`, `{ table }` (T-K), `{ expression, tRange }`, or `{ timeTable }` (transient only) — see [`docs/parameter-bindings.md`](docs/parameter-bindings.md)                                                                                                                                |
| `solidNodes[].heatInput`              | number                                                  | no                       | Heat source rate (W)                                                                                                                                                                                                                                                                                                                 |
| `solidNodes[].temperatureSchedule`    | `[[t, T], ...]`                                         | no                       | Time-varying ambient temperature                                                                                                                                                                                                                                                                                                     |
| `conductors[].id`                     | string                                                  | yes                      | Unique conductor identifier                                                                                                                                                                                                                                                                                                          |
| `conductors[].from`, `to`             | string                                                  | yes                      | Endpoint node ids                                                                                                                                                                                                                                                                                                                    |
| `conductors[].type.kind`              | `"conduction"`                                          | `"convection"`           | `"radiation"`                                                                                                                                                                                                                                                                                                                        | yes                                                                                                          | Heat transfer mechanism; conduction `k` accepts a `{ expr }` formula (resolved once at solve entry) or the same spec-object forms as `cp`; convection accepts a `correlation` block (heat-transfer model) |
| `branches[].component.type`           | `"pipe"`                                                | `"orifice"`              | `"orificeCompressible"`                                                                                                                                                                                                                                                                                                              | `"resistance"`                                                                                               | `"valve"`                                                                                                                                                                                                 | `"checkValve"` | `"dynamicCheckValve"` | `"reliefValve"` | `"pump"` | `"bend"` | `"areaChange"` | `"cavitatingVenturi"` | `"flowSource"` | `"regulator"` | `"heatedPipe"` | `"dpTable"` | `"customResistance"` | `"userComponent"` | yes | Component model |
| `branches[].component.inertia`        | `boolean`                                               | no                       | Include fluid inertia `(L/A)·dṁ/dt` on `pipe` branches (transient only)                                                                                                                                                                                                                                                              |
| `branches[].component.frictionFactor` | number                                                  | no                       | `pipe` only: constant Darcy friction factor overriding the laminar/Swamee–Jain correlations (0 = frictionless)                                                                                                                                                                                                                       |
| `branches[].component.diameterOut`    | number                                                  | no                       | `pipe` only: outlet diameter for a linearly tapered segment (nozzle sections); omitted means constant `diameter`                                                                                                                                                                                                                     |
| `branches[].initialMdot`              | number                                                  | no                       | Initial mass-flow guess [kg/s] for the steady Newton solve (near-choked compressible ducts need one, as in GFSSP)                                                                                                                                                                                                                    |

### Extensibility

Network JSON can define `dpTable` and `customResistance` branches without
code, or embed trusted JavaScript under `componentLibrary` for a
`userComponent` branch. Registers and lifecycle rules provide safe parsed
expressions, accepted/rejected-step semantics, and user stop conditions;
transient PID controllers can target valves, flow sources, boundaries, or heat
inputs. The complete current contract, examples, local `npm run serve`
workflow, and trust model are documented in [`docs/usercode.md`](docs/usercode.md).

**Conjugate heat-transfer snippet:**

```json
{
  "solidNodes": [
    {
      "id": "wall",
      "type": "solid",
      "x": 200,
      "y": 150,
      "temperature": 350,
      "mass": 1,
      "cp": 500,
      "heatInput": 5000
    },
    { "id": "amb", "type": "ambient", "x": 300, "y": 0, "temperature": 300 }
  ],
  "conductors": [
    {
      "id": "c1",
      "from": "wall",
      "to": "fluid1",
      "type": { "kind": "convection", "h": 1000, "area": 0.1 }
    },
    {
      "id": "c2",
      "from": "wall",
      "to": "amb",
      "type": {
        "kind": "radiation",
        "emissivity": 0.8,
        "area": 0.5,
        "viewFactor": 1
      }
    }
  ]
}
```

---

## Verification

The solver is verified against analytic solutions, GFSSP benchmark cases, NURETH published data, NBS-9264 chilldown experiments, and Lee-Martin two-phase data. See `docs/` for detailed verification records.

---

## Species Transport and Reacting Flows

**Architecture.** Operator splitting with node-local stiff ODE integration (BDF1 + dense Newton + adaptive sub-stepping), **not** monolithic Newton coupling of species into the global `[P, mdot, h]` vector. Species transport is advective upwinding in the outer successive-substitution loop (mirrors the enthalpy update). The chemistry sub-step runs once per converged time step, updating `nodeY` and `nodeT` for each internal node. Only **transient** reacting flow is supported; steady reacting flow is not supported. Only `idealGas` + species is valid; `realFluid` + species and `incompressible` + species are rejected by validation.

**Known limitation — BDF1 integrator.** The node-local chemistry integrator is 1st-order backward Euler (BDF1) with adaptive step-doubling. This is simple and robust for small reaction sets, but 1st-order accuracy means tight tolerances require many small sub-steps; large detailed mechanisms would benefit from a higher-order stiff integrator (e.g. Rosenbrock or BDF2+).

---

## Architecture Notes

### Worker-Based Solver Execution

To keep the UI responsive during long simulations, the solver runs inside a dedicated Web Worker (`src/ui/solverWorker.ts`). The main thread and the worker communicate via a typed message protocol:

- **Main → Worker:** `{type:'run', config, mode}` (the worker also recognizes `{type:'cancel'}`, but the UI cancellation path terminates it)
- **Worker → Main:** `{type:'ready'}` | `{type:'coolpropLoading'}` | `{type:'progress', payload}` | `{type:'done', result}` | `{type:'error', message}`

The worker is spawned as a Vite-native module worker (`new Worker(new URL('./solverWorker.ts', import.meta.url), { type: 'module' })`) and rebuilt automatically by `vite build` into a separate chunk.

**Progress emissions** — `solveTransient` invokes `onProgress` every `max(1, floor(totalSteps/200))` steps by default (customizable). The payload contains a cheap partial snapshot: arrays are sliced to the current length, so the cost per emit is `O(numTrackedVariables)` rather than `O(numSteps·numVariables)`. Messages are throttled to ≤10/s in the worker to avoid structured-clone overhead.

**CoolProp in the worker** — When any fluid spec is `realFluid` (`networkUsesRealFluid`), the worker calls `initRealFluids()` itself. The dynamic import of `coolprop-wasm` works in module workers under both `vite dev` and `vite preview` because Vite serves the co-located `.wasm` alongside the worker chunk. Init stays once-per-worker, not per substance.

**Embedded components in the worker** — The complete cloned config, including referenced `componentLibrary` source, is structured-cloned into the worker. Validation only syntax-checks source; referenced definitions execute when the worker builds solver context. This is trusted code, not a security sandbox.

**Cancellation** — Because the solve loop is synchronous, a posted `'cancel'` message cannot be observed mid-iteration without `SharedArrayBuffer`. The app avoids `SharedArrayBuffer` (which requires `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers). Instead, the client wrapper terminates the worker and respawns a fresh one on the next run. This is the simplest robust choice and is documented in `workerClient.ts`.

**Live charts** — On run start the UI auto-switches to the Results tab. `ResultsPanel` renders `TransientContent` from `liveResult` while `runStatus === 'running'`. `InteractiveChart` tolerates growing arrays without remounting: its internal `zoomDomain`, `hidden`, and `hoverIdx` states are local React state, so they persist across data-length changes. Zoom resets gracefully when the user double-clicks.

**Steady runs** — Steady-state solves also use the worker. The toolbar shows an indeterminate progress bar with live iteration count and residual. Results tables appear only on `done`.

---

## Limitations & Roadmap

### Current Limitations

- **No shock capture.** With `momentumFlux` + `kineticEnergy` the solver handles quasi-1-D compressible duct flow — Fanno friction choking, Rayleigh thermal choking, and converging–diverging nozzles, validated against the NASA GFSSP verification paper (see [Compressible duct flow](#compressible-duct-flow-settingskineticenergy)). A supersonic bell is reachable when seeded onto that branch, as the shipped LOX/RP-1 thruster does. But there is no Rankine–Hugoniot jump condition, so shock position, over-expanded/separated operation, and any supersonic → subsonic transition are out of scope; thrust is not computed either, since the solver returns the internal flow field rather than a vehicle momentum balance. Point choking at restrictions is still available via `orificeCompressible` (isentropic ideal-gas) and `cavitatingVenturi` (choked liquid). With the flags off (the default), momentum is the incompressible per-branch relation $\Delta P(\dot{m})$ with no Fanno-flow treatment.
- **Kinetic-energy transport is steady-oriented** – `kineticEnergy` works with any fluid model (species networks keep the segregated stagnation-enthalpy update). The fully-coupled pressure–flow–enthalpy Newton system that holds near-sonic states runs in steady mode; transient solves use the segregated stagnation-enthalpy update, which is not designed to track choking fronts. Near-choked steady cases benefit from choke-clustered grids; under the default `momentumFluxScheme: "upwind"` they converge from cold starts, while `"central"` needs initial guesses (`initialMdot`, node P/T) on the physical branch, as GFSSP itself requires. Without the flag, the energy equation fluxes static enthalpy only, so velocity-head-to-temperature conversion is not modeled.
- **No acoustic wave propagation (water hammer)** – transient momentum offers lumped fluid inertia $(L/A)\,d\dot{m}/dt$, which captures bulk surge, but there is no distributed wave equation or method-of-characteristics solution. Pressure-wave timing, reflection, and anything limited by the speed of sound cannot be simulated.
- **Cavitation only at the venturi closure** – there is no general cavitation-inception check on pumps, valves, or low-pressure nodes in liquid networks.
- **Turbomachinery is a pump curve** – pressure rise vs. volumetric flow only. No compressor/turbine maps and no shaft-work term in the energy equation, so pump heating of the fluid is not captured.
- **No junction mixing** – unlike fluids may not meet at a node. Couple them thermally through a solid wall. Mixed EOS classes (e.g. an ideal-gas hot side with a CoolProp coolant) are allowed exactly because the wall is the only coupling.
- **User-code trust and scope** – embedded/local components execute trusted JavaScript with `new Function`; this is not a security boundary. Loading unmatched embedded code requires consent remembered by source hash. Callbacks receive scalar flow/state arguments and a branch-scoped read-only fluid accessor, but no global registry, register/network access, async API, persistent state, or dual derivative support. See [`docs/usercode.md`](docs/usercode.md).
- **Control scope** – PID controllers are transient-only, execute on `stepAccepted`, have no anti-windup, and affect the next step unless `initialOutput` seeds the first. Logic can update registers and stop solves but cannot directly mutate network component settings.
- **Two-phase support** – transient two-phase flow is supported for real fluids through a homogeneous-equilibrium model (HEM): mixture properties via `statePH`, an extended `[P, mdot, h]` solve, HEM momentum (mixture density + McAdams viscosity) in pipe/orifice/valve pressure-drop relations, and the Miropolskii film-boiling correlation for conjugate heat transfer. Verified against boiling/condensation staircases, saturated blowdown, and the NBS/GFSSP two-phase chilldown benchmark. The HEM assumption is most accurate for dispersed, high-mixing, or low-quality flows; at high void fractions it under-predicts pressure drop compared to separated-flow correlations (e.g. Lockhart–Martinelli, not yet implemented).
- **Steady closed ideal-gas loops** – a fully-closed valve in a steady ideal-gas closed loop creates a singular Jacobian because there is no pressure anchor. Use a small open leak (tiny valve area) to condition the Jacobian, or run in transient mode where $d\rho/dt$ regularizes the system.

### Roadmap

- [x] Multi-fluid networks (isolated continua, mixed EOS classes) and explicit per-branch fluid context for user components
- [x] Reacting flows — transient ideal-gas species transport with stiff Arrhenius chemistry (see [Species Transport and Reacting Flows](#species-transport-and-reacting-flows))
- [ ] Steady reacting flow
- [ ] Lockhart–Martinelli separated-flow pressure-drop multipliers
- [x] Kinetic-energy (stagnation-enthalpy) term in the energy balance (`settings.kineticEnergy`, any EOS via the coupled `[P, ṁ, h]` steady system)
- [x] Compressible duct flow: Fanno/Rayleigh choking and quasi-1-D converging–diverging nozzles via tapered pipes (validated against NASA GFSSP TFAWS-2007)
- [ ] Shock capture (Rankine–Hugoniot jump, over-expanded/separated nozzles, thrust)
- [ ] Distributed acoustic wave propagation (method of characteristics) for water-hammer transients
- [ ] Cavitation-inception warnings on pumps, valves, and low-pressure liquid nodes
- [ ] Higher-order stiff chemistry integrator (Rosenbrock or BDF2+) to replace node-local BDF1

---

## How to Cite

If this software contributes to your research, please cite it. See [CITATION.cff](CITATION.cff) for the current citation metadata, or use:

> Rising, J. (2026). OpenFLUME: Open FLUid Model Environment (v0.1.0). Zenodo. [https://doi.org/10.5281/zenodo.22051608](https://doi.org/10.5281/zenodo.22051608)

---

## License

[MIT](LICENSE)
