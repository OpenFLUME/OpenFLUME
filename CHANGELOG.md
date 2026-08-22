# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates follow [ISO 8601](https://www.iso.org/iso-8601-date-and-time-format.html)
(`YYYY-MM-DD`).

## [Unreleased]

### Added

- **Limited-upwind momentum faces** (`settings.momentumFluxScheme`, default
  `"upwind"`) — GFSSP-style donor-cell momentum advection with MUSCL/van
  Albada limited face densities on compressible branches. Removes the
  central form's discrete expansion-shock roots by construction, making
  transonic solves seed-robust (choked flow lands 2–6 % high, first-order
  at the sonic cell). The legacy exact-integral `"central"` scheme remains
  available and is certified post-hoc by a second-law admissibility audit
  (`settings.transonicAdmissibility`) with re-seeding and
  `SteadyResult.warnings`.
- **Real-fluid transonic flow** — real-fluid (CoolProp) branches are
  upwind-eligible whenever `kineticEnergy` is on, so real fluids choke
  emergently through the same coupled `[P, ṁ, h]` Mach coupling as ideal
  gases. Validated with a nitrogen choked CD nozzle against an analytic
  ideal-gas twin (0.17 % mass-flow agreement, flat-cold-start robustness).

### Fixed

- **Reported branch ΔP under `momentumFlux`** — the reported pressure drop
  now mirrors the converged momentum row exactly (`P_from − P_to` less the
  fluid-inertia term) instead of re-deriving a legacy constant-area central
  acceleration term that disagreed with the default upwind scheme, tapered
  branches, and junction-inlet exclusions.
- **Critical-point lookup fails loudly** — a failed CoolProp `PCRIT`/`TCRIT`
  read now throws instead of silently caching a fabricated critical point
  (`Pc = 1e7 Pa, Tc = 300 K`) that misrouted every downstream phase-region
  decision for the process lifetime.
- **Near-critical two-phase states** — the `h_g − h_f` gap is clamped in
  `statePH`'s dome branch and `twoPhaseDerivs`, so pressures approaching
  `Pc⁻` yield huge-but-finite qualities/derivatives instead of NaN/∞ in the
  Newton Jacobian. PT- and PH-path property reads gained output finiteness
  guards.
- **Zero-flow NaNs** — `darcyFrictionFactor` guards a non-finite Reynolds
  number (mdot = 0 with a zero-viscosity fluid) like its dual twin, fixing
  `Pipe`/`Bend.pressureDrop`; `HeatedPipe.getBranchHeat` returns 0 at zero
  flow instead of NaN when `ua = 0`.
- **`solveDense` regularization keeps the pivot sign** — a near-singular
  negative pivot no longer flips the Newton step direction.
- **Convection dispatcher fails loudly on an unknown correlation model**
  instead of silently evaluating it as Darr–Hartwig.
- **Pump curve validation** now requires strictly increasing flow points
  (the interpolator's assumption).
- **Canvas subnetwork creation** — a selected solid node's position is
  looked up by id (a truthiness bug could place the group container far
  from its members).
- **Schedule editor** — pasted multi-row blocks keep both columns; pending
  cell edits are committed and cleared before row remove/sort (a stale
  index could corrupt a reindexed row in Safari/Firefox); numeric cells
  reject trailing garbage ("10 ft") instead of silently truncating.
- **UI robustness** — `KTableField` no longer crashes on an empty K-table;
  solid-node temperature CSV export emits an empty cell instead of "NaN";
  store removal actions no longer materialize absent optional arrays;
  large-array `Math.min/max` spreads replaced with loop helpers; chart PNG
  export reports image-load failures; conditional React hooks in
  `CustomNode`/`CustomSolidNode` hoisted above the ghost early-return;
  connect-tool canvas rebuilds reuse one topology model (was O(N²)).
- **Solver worker hardening** — exfiltration-capable globals (`fetch`,
  `XMLHttpRequest`, `WebSocket`, `indexedDB`, `caches`, …) are stripped
  from the worker scope before any solve, as defense in depth around
  user-authored component code; the dead in-band cancel protocol was
  removed (cancel is terminate+respawn).
- **CI/config** — the scheduled/main job now runs the slow scientific
  suite (`RUN_SLOW=1`) and the full Playwright e2e suite (previously never
  run anywhere); `react-hooks/rules-of-hooks` is a lint error;
  `scripts/**` is typechecked; deploy credentials are scoped to the deploy
  job; stale example counts corrected.

### Changed

- **Example library** — dropped the standalone regenerative-cooling-channel
  and choked-CD-nozzle examples. Regenerative cooling and the choked nozzle
  now live only in the LOX/RP-1 thruster (combustor), which already couples
  both to a CEA reacting junction. Twelve shipped examples remain.
  Benchmark names no longer lead with GFSSP or SINDA/FLUINT; the citation
  is on the canvas note (e.g. "Reference: GFSSP Figure 10").
- **Real-fluid performance report** — re-measured on the current solver
  (limited-upwind faces, real-fluid transonic `[P, ṁ, h]`). Analytic Jacobian
  still dominates CoolProp cost; `statePH` memoization is documented as a
  would-be cache, not an implemented one. Regenerable via
  `npx tsx scripts/real-fluid-performance.ts`.

## [0.1.0] - 2026-08-20

Initial public release of OpenFLUME (Open FLUid Model Environment).

### Added

- **Browser-first simulation** — a local-first finite-volume thermo-fluid
  network application and TypeScript solver library. Models solve in a web
  worker; no cloud service is required. An optional local companion server can
  serve the built app and discover local component files.
- **Steady and transient solvers** — coupled Newton–Raphson steady analysis and
  backward-Euler transient analysis with fixed or adaptive stepping, hybrid
  automatic/finite-difference Jacobians, scaling, line search and trust-region
  globalization, real-fluid PTC regularization, fluid inertia, trapped-gas
  cushions, schedules, event alignment, cancellation, and residual-based
  convergence reporting.
- **Fluid and energy models** — incompressible and thermally expandable
  liquids, ideal gases, and 124 CoolProp HEOS real fluids with two-phase
  properties. The enthalpy-primary `[P, ṁ, h]` system supports kinetic energy
  with every EOS; named fluid continua with different EOS classes can coexist
  and exchange heat through solids.
- **Compressible duct flow** — optional quasi-1-D momentum-flux and
  stagnation-enthalpy transport for Fanno friction, Rayleigh heating,
  converging-diverging nozzles, choking, and seeded supersonic expansion.
- **Flow components** — pipe, incompressible and compressible orifices,
  resistance, scheduled valve, static and dynamic check valves, relief valve,
  pump, bend, area change, cavitating venturi, flow source, pressure regulator,
  heated pipe, pressure-drop table, Reynolds-dependent resistance, and trusted
  user components. The dynamic check valve includes accepted-step
  spring-mass-damper poppet dynamics in transient runs; steady runs hold its
  configured initial position.
- **Conjugate heat transfer** — solid and ambient nodes coupled by conduction,
  convection, and radiation. Convection supports specified/custom
  coefficients, Dittus–Boelter, Miropolskii, Darr–Hartwig, and TT-WF models.
  Solid specific heat and conductivity support constants, sourced materials,
  temperature tables, temperature equations, and transient time tables.
  Opt-in fluid-front transport can gate TT-WF dry-side heat release.
- **Material catalogue** — sourced, range-aware properties for OFHC copper,
  GRCop-84, Aluminum 6061-T6, stainless steels 304 and 316, Inconel 718, PTFE,
  and anisotropic G-10 CR, with documented interpolation, clamping, provenance,
  and regression coverage.
- **Species and controls** — optional transient ideal-gas species advection and
  node-local stiff Arrhenius chemistry, plus safe expressions, lifecycle
  registers, stop/logic rules, and transient PID controllers.
- **Visual model editor** — drag-and-drop P&ID canvas, click or drag
  connections, component-specific property panels, undo/redo, multi-selection,
  model tables, physical-coordinate and 3-D views, free-form notes, automatic
  orientation, and subnetwork groups with tabs and ghost ports.
- **Formula-bound parameters** — selected geometry, component, and conductor
  fields can reference other model geometry through a safe static expression
  language, with dependency validation, unit-aware previews, and lossless text
  round trips.
- **Units and visualization** — SI, metric-engineering, and US-customary
  display presets (including Rankine), engineering formatting, time scrubbing,
  and shared canvas/channel coloring for all reported node, branch, and
  conductor quantities, including vapor quality.
- **Analysis workspace** — channel presets and custom plots, transient charts,
  result tables, run details and history, run comparison, solver convergence
  diaries, partial cancelled trajectories, and provenance-bearing CSV, JSON,
  and text exports.
- **Derived results** — enthalpy, internal energy, entropy, viscosity, specific
  heat, thermal conductivity, speed of sound, velocity, pressure drop,
  Reynolds and Mach numbers, volumetric flow, mass flux, dynamic pressure, heat
  flux, and heat-transfer coefficient where supported by the model.
- **Parameter exploration** — session-only linear sweeps of supported scalar
  fields, sequential worker execution, cancellation/rerun, variant comparison,
  provenance CSV export, stale-model detection, and promotion into Analysis
  history without mutating the source model.
- **Persistence and source editing** — lossless `.fn` text projection, Model
  Text editor, save/load, browser autosave, model provenance hashes, and canvas
  notes that do not invalidate numerical results.
- **Examples** — 13 shipped networks covering inspection, applications,
  published benchmarks, and extensibility, including tank blowdown, a
  single-phase cryogenic line-cooldown surrogate, conjugate heat transfer,
  mixed-fluid regenerative cooling, and a choked rocket chamber/nozzle.
- **Documentation and verification** — a complete user manual, architecture
  and extensibility references, worked examples, material/property references,
  and reproducible validation reports for incompressible hydraulics,
  compressible flow, thermal networks, tank transients, and rigid-column fluid
  transients. Automated coverage includes fast/full/slow Vitest tiers and
  Playwright end-to-end tests.
- **Validation and diagnostics** — pre-solve structural, physical, expression,
  and property validation with field-specific errors, plus issues and
  convergence evidence surfaced in the interface.

### Known limitations

- Compressible duct flow does not capture shocks, acoustic waves, or
  Rankine–Hugoniot jumps. Supersonic nozzle solutions require appropriate
  initialization, and thrust is not calculated.
- Fully coupled near-sonic kinetic-energy analysis is steady-oriented;
  transients use a segregated stagnation-enthalpy update and are not intended
  to track moving choking fronts.
- Real-fluid two-phase flow uses a homogeneous-equilibrium model; separated
  flow effects and general cavitation inception are not modeled, and difficult
  saturation-dome states can exhibit documented convergence limits.
- Fluid inertia is a lumped rigid-column model, not distributed water-hammer
  or method-of-characteristics wave propagation.
- Unlike fluid continua cannot mix at a junction and may couple only through
  solid walls.
- Reacting species transport is transient-only, and PID controllers do not
  provide anti-windup.
- User components execute trusted JavaScript and are not a security sandbox.
- The shipped cryogenic cooldown example is a qualitative single-phase
  surrogate, not a prediction of absolute two-phase chilldown time.
- The text projection (`.fn`) stores raw SI numbers only (property panels and
  results honor the display-unit preferences).
- Parameter sweeps and convergence diaries are session-only (not persisted).

[Unreleased]: https://github.com/OpenFLUME/OpenFLUME/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OpenFLUME/OpenFLUME/releases/tag/v0.1.0
