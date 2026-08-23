# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates follow [ISO 8601](https://www.iso.org/iso-8601-date-and-time-format.html)
(`YYYY-MM-DD`).

## [Unreleased]

## [0.2.1] - 2026-08-23

### Added

- **Results tab overhaul: plots you compose, instead of views we chose.**
  - The tab now holds any number of **plots**, each its own tab (add, rename by
    double-click, close). A plot is an **x axis** plus a **list of channels** —
    that is the entire model. Two questions can be on screen at once instead of
    one replacing the other, and plots live in the store so leaving the tab
    does not discard them.
  - **The x axis is the only mode there is**: Time (transient), Station along a
    flow path, Position X/Y/Z, or Element order. It decides what a channel
    means, and the distinction is load-bearing: on a time axis a channel is a
    SERIES (three node pressures draw three lines), on any spatial axis it is a
    POINT (three node pressures draw one line across the network, because what
    varies along the axis is the element, not the sample). Getting that
    backwards is what makes a generic plotter useless for network results.
  - Plotting node pressures against **Station** is therefore the hydraulic
    grade line, answering "where is my pressure going" rather than "how big is
    each value".
    - Flow direction is a RESULT, not a declaration: `type: "boundary"` marks a
      reservoir and a branch's `from → to` is only a sign convention. New
      `src/ui/flowPath.ts` orients the network by the solved `mdot` signs and
      walks it downstream, so reverse flow renders the right way round.
    - The path selector offers every candidate, best first by throughput (the
      narrowest segment, not the first — paths out of one inlet share their
      opening run). A tee contributes one path per outlet, two uncoupled
      streams contribute their own, a closed circulation loop with a single
      boundary is offered as a loop, and a discharging tank seeds a path from
      the internal node the mass is leaving.
    - Per-span quantities (a branch's mass flow or ΔP) draw as stairs, because
      a component's value does not vary along itself.
  - **Axes degrade honestly**: Station is real metres when every component on
    the path carries a length or its endpoints carry physical positions, and an
    index that says so when even one does not. An element with no coordinate on
    the chosen axis is left out and named, never placed at zero.
  - **A new plot is EMPTY.** Nothing is pre-selected: which of several hundred
    channels matters is not something the tool can guess.
  - **The x axis is chosen AT the axis**: the label under the chart is the
    control, with the flow-path selector beside it. Exports still name the
    axis in their title line, so a downloaded image loses nothing.
  - **The channel picker states what is plotted.** A **Plotted** block at the
    top lists the plot's channels with their values and an × to drop each,
    because "what am I looking at" should never require scrolling a list.
    Below it, one line of familiar controls narrows everything the result
    carries: a search box, a sort menu (by quantity, the default, or by
    element) and a filter menu (element types, each with its canvas glyph).
    The previous row of bare toggle buttons read as neither a filter nor a
    sort. Presets became one compact control rather than the front door.
  - **Findings** (`src/core/resultFindings.ts`, the post-run companion to
    `modelAdvisor.ts`) — deterministic readings with their reasons: the
    component that dominates the pressure drop, branches running backwards,
    near-sonic and sonic flow, mass that does not balance at a steady junction,
    and solver advisories passed through verbatim. Each selects the element it
    names. Silent when the result reads cleanly. "Dominant" requires both half
    the total loss AND twice the runner-up, so an even 50/50 split is not
    reported as domination.
  - `src/core/graph.ts` — the adjacency, traversal and station-axis primitives
    both this and `geometry.ts` needed; `geometry.ts`'s private pipe-path
    helpers now come from there, so there is one implementation.
  - **The Results tab's title IS the run selector.** The sticky run strip is gone;
    the heading that said "Plots" now names the displayed run, switches to any
    record, and carries the outcome badge, the run's evidence and its
    partial/baseline flags. A heading that says nothing over a bar that repeats
    itself was two lines of chrome for one fact. The strip's jump buttons go
    with it — each section already opens from its own header.
  - **Charts label their axes like charts**: the y quantity is written down the
    y axis rather than in a header line above the plot, which pairs with the x
    axis selector already sitting in the x label's place.
  - **Any number of runs on one plot.** A plot's **Results** row names the run it
    reads and offers **+ Compare run…** for every other record; the same
    channels are resolved against each and drawn on the same axes, dashed and
    colour-matched to the channel they mirror, each labelled with its run. This
    is the comparison run history exists for — "which design was better?" — and
    it is per-plot, so one tab can compare two designs while the next reads the
    latest run alone (cap: four overlays).
    - Each overlay is resolved against **its own captured config**, so a
      variant that moved a node or lengthened a pipe plots on the geometry it
      actually ran.
    - `resampleOnto` (`plotSeries.ts`) interpolates an overlay onto the plot's
      x grid instead of reading it off by index, which would silently slide a
      run sampled on a different timestep along the axis — the exact error a
      comparison plot exists to prevent. Per-span quantities hold their value
      rather than sloping, and nothing is extrapolated past what a run covers.
    - The pinned baseline now renders through this same path rather than its
      own one-off overlay.
  - `InteractiveChart` gained per-series stepped rendering, and now skips
    non-finite samples instead of letting one `NaN` invalidate the whole
    polyline and drop the series.
- **Simulation variants** — a model file can now carry named alternatives to
  its network, so one `.fn` holds the design and the cases you want to compare
  against it.
  - Stored inside the `.fn` file as a new `variants:` field holding SPARSE
    patches (settings, per-element field overrides, added and removed
    elements) rather than copies, so the file stays small and readable as a
    diff and base edits keep propagating into every variant that does not
    override them. Files without variants serialize byte-identically, so the
    format extension is backwards compatible with no header bump.
  - `src/core/variants.ts` owns `applyVariant` / `diffVariant` as exact
    inverses (property-tested round trip). Patches naming elements the base no
    longer has are skipped and reported rather than thrown, because base edits
    and variant patches are authored independently.
  - Editing while a variant is active records into that variant's patch and
    leaves the base network untouched. Variants are excluded from the
    provenance hash, so adding one cannot stale another's results.
  - A **variant picker** at the top of the project outline switches variants
    and labels every section below it; rows the active variant overrides are
    marked, and the variant name also appears in the toolbar so it stays
    visible when the outline is hidden (Ctrl+\).
- **Runs are scoped to their model and variant.** Each run records the variant
  that produced it and appears in a flat, chronological, variant-tagged
  **Results** list; the ring-buffer cap is now per variant. Loading a different
  model clears the history, fixing runs from a previous file appearing in the
  new one's Results tab. A run from _another_ variant can be pinned as the
  comparison baseline, which is how variants are compared — the existing delta
  columns and dashed chart overlay do the work.
- **Results sidecar** — results are no longer session-only. They are mirrored
  into browser storage (so a reload resumes the session) and written to a
  portable `<model>.runs.json` containing each run's config snapshot, result,
  and diary. **Save** in the toolbar writes the model and, when there are runs,
  the sidecar with it, so one action captures the whole session; **Save** in
  the outline's Results section writes the sidecar alone. **Load** accepts a
  sidecar and attaches its runs to the open model.
- **Results can be discarded.** The **×** on a run row discards that run and
  **Discard** in the Results section header drops the whole list. Both confirm
  first, naming the run or counting the runs at stake, and both clear the
  browser-storage mirror — which also fixes the per-run delete in the Results
  tab: it used to leave the run in storage, so a reload brought it back.
  Neither is undoable, which the confirmations say.
- **Project outline polish**
  - Element rows now carry the **same symbol the canvas draws** — circle
    (internal node), rounded square (boundary), diamond (solid, dashed when
    ambient), and the component's P&ID glyph for branches and conductors — via
    a new shared `EntityGlyph` that the canvas creation rail also uses, so the
    two can no longer drift. Text badges (`PIPE`, `BND`) are gone.
  - **Instant hover summary cards**: hovering a row opens a panel naming the
    element, its endpoints, the two or three parameters that define it (with
    formula bindings shown as their expression), and its solved values when a
    run is displayed.
  - **Drag-reorder** within a section. Ordering round-trips through the `.fn`
    file and is undoable, but never marks results stale — see below.
  - Larger rotating chevrons and status icons in place of the tiny Unicode
    triangles and 7px dots.
- **Studio shell — a docked-IDE window layout** (COMSOL/FLACS direction)
  replaces the floating-panel layout. Three prototype shells (docked IDE,
  guided workflow stages, canvas-first minimal chrome) were built behind a
  `?shell=` flag, evaluated side by side, and the docked IDE won with the
  canvas-first prototype's command palette folded in; the flag and the losing
  shells were then removed. The new window is:
  - **Project outline** (left, Ctrl+\ toggles): one searchable tree over the
    whole project — Setup (solver / physics / fluids with named-fluid
    children / species / units / extensibility, each annotated with its
    current value; clicking opens the Setup tab on that section),
    every model entity (click to select and zoom), and the run history.
    Rows carry status icons fed by the readiness checks and validation errors,
    so "what is wrong and where" is answered by the tree.
  - **Docked properties inspector** (right, resizable) replacing the floating
    overlay — the panel no longer occludes the canvas, and it mounts only when
    something is selected so the canvas keeps the width otherwise.
  - **Setup as a workspace tab** replacing the modal settings dialog
    (see Changed).
  - **Command palette** (Cmd/Ctrl+K): run/cancel, place elements, open views,
    and jump to any element by id.
- **Full-detail zoom is now density-aware** — small models (≤50 elements)
  keep their canvas readout chips down to zoom 0.6 (dense models keep the
  conservative 0.75), compensating for the narrower canvas pane between the
  docks.
- **Problem-type templates in the New-model flow** — New now opens a template
  picker: Blank network (default, preserving the historical flow) plus six
  seeded starting points (liquid distribution, gas blowdown, conjugate heated
  pipe, counterflow heat exchanger, cryogenic chilldown, thruster feed) that
  pre-configure fluid, solver mode and numerics, physics flags, and a runnable
  starter topology, each labelled with what it seeds.
- **Deterministic solver-settings advisor** — `suggestSolverSettings()` in the
  core inspects the model (schedules → transient with derived dt/end time, gas
  through area changes → momentum flux + kinetic energy, two-phase-prone setups
  → extra under-relaxation, stiff transients → adaptive stepping) and the
  Solver settings tab shows each suggestion with its reason and a one-click
  Apply all. Silent when current settings already match.
- **Model readiness checklist** — `assessModelReadiness()` plus a checklist
  panel that combines advisory setup checks (topology, boundary conditions,
  connectivity, fluid, solve settings) with the live validation errors;
  each row click-selects the offending element. Hosted in the Studio drawer,
  the Guided Solve stage, and summarized in the canvas-first status strip.

- **Sectioned global settings** — six horizontal sections (Solver, Physics,
  Fluids, Species, Units, Extensibility) instead of one scrolling column of
  grids. It opens on Solver and returns there when you leave, so the basics
  stay one click away while the advanced surfaces get room.
- **Compressible formulation in the UI** — `settings.momentumFlux`,
  `kineticEnergy`, `momentumFluxScheme`, and `transonicAdmissibility` are
  editable on the new Physics tab, with the interlocks made visible (the scheme
  select is inert without momentum flux, the second-law audit is enabled only
  for the steady central-scheme case it applies to) and a derived line naming
  the formulation the current flags select. Previously these were reachable only
  by hand-editing the model text.
- **Newton strategy in the UI** — `settings.steadySolver`, `globalization`,
  `jacobian`, and the experimental `certifyAfterCoupling`, plus the adaptive
  absolute floors `adaptive.absTolP` / `absTolT`, behind an Advanced numerics
  disclosure on the Solver tab.
- **Closure-calibration editor** — `config.closureParams` (Dittus–Boelter,
  Miropolskii, Swamee–Jain constants plus the `solidCpScale` material
  multiplier) with published defaults as placeholders. Clearing a field deletes
  the key and an emptied group is dropped, so a network that overrides nothing
  stays bit-identical to one that never carried the field.
- **Species editor** — `config.species` gets a Settings tab: the species roster
  with optional whole-column cp / formation-enthalpy / viscosity properties, and
  an Arrhenius reaction list whose stoichiometry is entered per declared species
  so a reaction cannot name an unknown one. Node `massFractions` become editable
  in the property panel once species exist, with a running sum and a normalize
  action; removing a species purges its fractions.
- **Property-panel fields that had no control** — `branch.initialMdot` (as
  _Initial flow guess_, reading _Auto (0.1 kg/s)_ when unset),
  `pipe.frictionFactor` behind a Correlation/Constant-f mode selector (absent and
  zero are different configurations, so the mode is explicit),
  `pipe.diameterOut` behind a _Tapered outlet_ toggle,
  `heatedPipe.boilingModel`, `node.quality` behind a realFluid-only state-variable
  selector that keeps it mutually exclusive with temperature, and
  `node.fluidFrontInlet` on boundary nodes once a conductor opts into front
  transport.

### Changed

- **One orifice, one mass-flow law.** `orifice` and `orificeCompressible` are
  a single component. Mass flow is $\dot m = C_d A Y(r,\kappa)\sqrt{2\rho\Delta P}$
  with the ISO/AGA expansibility factor $Y$: $Y=1$ for liquids, $Y(r,\kappa)$
  (and choking at $r_*$) for gases. $\kappa$ is $\gamma$ for an ideal gas and
  $a^2\rho/P$ for a real fluid. Saved models that still say `orificeCompressible`
  load as `orifice`.

- **The steady bar charts are gone.** They normalized every channel to the
  largest value in the set, so the ordering carried no meaning and a tee
  rendered like a twenty-station chilldown: everything about how the components
  relate was lost. Plot against an axis instead — Element order gives the same
  comparison without pretending to be more.
- **The View dropdown and the preset/custom duality are gone**, along with the
  pinned set, the "primary" channel and follow-the-selection. A plot owns its
  channel list outright, so there is nothing to cap and nothing to derive;
  `src/ui/channelExplorer.ts` shrank to formatting and search.
- **The run overview cards are gone** — solve outcome, pressure and temperature
  envelopes, peak mass flow, numerical evidence, mass balance. Every one was
  already answered somewhere the analyst actually looks: the outcome and
  residual in the run strip, the envelopes in the plots themselves, and
  conservation by the mass-imbalance finding, which says so only when it is
  wrong instead of printing "0% of peak flow" on every healthy run.
- **Row status is an icon, and only for trouble** — an amber warning triangle
  or a red error circle, with healthy rows left unmarked. The green dot it
  replaces was wrong twice over: it read as one more entity glyph beside the
  outline's green boundary-node squares, and a column of "everything is fine"
  markers is noise you have to read past to find the one row that matters.
  Interior marks sit on top of the filled shapes rather than being knocked out
  of them, so the icons hold up on every row background. The variant picker's
  outcome marker shares the same component.
- **A pinned comparison baseline stays gold.** The star only turned gold on
  hover, so which run was pinned was invisible once the pointer moved away; it
  now stays lit and carries `aria-pressed`. Restoring a session also selects
  the newest run again, which fixes a pin that silently did nothing after a
  reload: pinning a baseline needs a displayed run to compare against, and
  nothing was selected.
- **Global Settings is now the Setup workspace tab**, alongside Model, Sweep,
  and Results. It had already stopped being a dialog; making it a tab makes
  the tab strip the one place that answers "which view am I in", and it now
  carries the same name as the outline section that links into it. The
  toolbar's Settings button is gone (the tab and the outline rows reach it),
  Escape no longer exits the view because a tab is not a dismissable overlay,
  and the store models it as `activeTab === 'config'` rather than a separate
  `showSettings` flag. Its six sections are unchanged, and it still opens on
  Solver and returns there when you leave.
- **The analysis workspace is the Results tab**, matching the outline's Results
  section and the run records it lists.
- **User-manual screenshots recaptured** from the 0.2.1 studio shell (docked
  outline, Setup / Results tabs, and composed plots). Regenerate with
  `npm run build && npx tsx scripts/capture-manual-figures.ts`.
- **The provenance hash now ignores entity array order.** Two configs that
  differ only in the order elements are listed describe the same network — the
  solver publishes the same id-keyed results — so `configHash` canonicalizes
  the order away, exactly as it already strips `notes`. This is what lets the
  new drag-reorder be a real, saved, undoable edit without invalidating a
  pinned run baseline. (Reordering does permute the solver's DOF layout, so a
  re-solve is physically identical but not bit-identical.)
- **The Sweep workspace's Promote now creates a saved variant** instead of
  appending a bare record to run history: the swept value becomes the variant's
  name, the swept field becomes its patch, and the promoted run is filed under
  it. Sweeps remain the session-only batch explorer; Promote is how an
  interesting point graduates into something that survives the session.
- **The run-and-readiness drawer is gone.** Run outcome already lives in the
  toolbar status pill and per-element readiness in the outline's status icons, so
  a third copy of both only cost the canvas height. `assessModelReadiness()`
  stays as the source of the outline's amber dots. The command-palette button
  moved to the toolbar.
- **Run orchestration extracted from the toolbar** — the worker/diary/trust
  lifecycle of a manual run now lives in `src/ui/runController.ts`, so any
  surface (toolbar, command palette, outline) starts and cancels runs through
  one shared, behavior-identical path.
- **Shell chrome decomposed for reuse** — the canvas tool rail is its own
  `CanvasRail` component, the Global Settings tab strip + bodies are mountable
  anywhere via `SettingsSections` (whole or one section at a time), and the
  workspace tabs / center view moved to shared shell building blocks. All
  legacy test ids are unchanged.
- **`customResistance` K(Re) tables are editable in the property panel**, as a
  Reynolds/K point grid beside the existing readout of the curve and the K last
  interpolated. A constant K can be promoted to a table (seeded flat, so K does
  not jump) and a table collapsed back. The panel no longer sends users to the
  model text view, and the optional `diameter` a table needs can be added from
  the panel rather than only edited when already present.
- **Entity and settings patches drop cleared keys** — `updateSettings`,
  `updateNode`, `updateBranch`, `updateSolidNode`, and `updateConductor` now
  remove `undefined`-valued keys at any depth instead of leaving them for the
  next `cloneConfig` JSON round-trip to strip. The in-memory config equals what
  a reload would produce, so text projection and provenance hashing see the same
  model.

## [0.2.0] - 2026-08-22

### Added

- **CEA-coupled reacting junctions** (`config.junctions`) — steady
  `kineticEnergy` solves can now join unlike oxidizer and fuel streams at a
  chamber node and close chamber pressure, O/F, temperature, and product-gas
  properties inside the monolithic Newton system. Offline NASA CEA tables
  cover LOX/RP-1 and LOX/CH₄ over 0.2–30 MPa and O/F 1–5. The shipped
  LOX/RP-1 thruster combines this closure with a choked nozzle and a
  42-station three-layer regenerative jacket; the combustion validation
  report checks CEA identities, chamber/injector balances, nozzle profiles,
  and the wall resistance network.
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
- **Bounded fused real-fluid value caches** — one 8192-entry exact-key
  `(fluid, P, h)` cache now serves `statePH`, `internalEnergyPH`, and
  `derivativesPH` together, while bounded generation caches cover supporting
  property lookups. This removes repeated flashes without the unbounded heap
  growth previously seen in long transients.

### Fixed

- **The toolbar no longer clips Cancel while a run is in flight** — the status
  cluster refused to shrink, so a narrow window cut into the button that stops
  a long transient. Run and Cancel are now unclippable and the in-flight
  progress readout is the one thing that yields: a number you cannot finish
  reading is cheaper to lose than the only way to stop the run.
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
- **Formula previews** — committed formulas remain visible in the property
  panel when parameter resolution succeeds without returning that field in
  the resolved-binding map.
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
  connect-tool canvas rebuilds reuse one topology model (was O(N²)); stale
  React Flow callbacks no longer turn single selections into bulk selections;
  newly authored local components connect and embed immediately; and formula
  options open reliably from literal visual fields.
- **Solver worker hardening** — exfiltration-capable globals (`fetch`,
  `XMLHttpRequest`, `WebSocket`, `indexedDB`, `caches`, …) are stripped
  from the worker scope before any solve, as defense in depth around
  user-authored component code; the dead in-band cancel protocol was
  removed (cancel is terminate+respawn).
- **CI/config** — the scheduled/main job now runs the slow scientific
  suite (`RUN_SLOW=1`) and the full Playwright e2e suite (previously never
  run anywhere); `react-hooks/rules-of-hooks` is a lint error;
  `scripts/**` is typechecked; deploy credentials are scoped to the deploy
  job; stale example counts corrected; and the repository lint baseline is
  clean with zero warnings. Full scientific and four-way-sharded e2e jobs now
  gate pull requests, with Playwright diagnostics retained as artifacts.

### Changed

- **Solver hot paths** — nodal incidence and convection tables replace
  repeated whole-network scans; static predicates, residual seeds, and dual
  workspaces are reused; and accepted-step state restoration refills existing
  containers. These changes preserve accumulation order while reducing
  residual and Jacobian overhead on large networks.
- **Named-fluid settings** — every named continuum now has the same model,
  preset, CoolProp picker, and editable numeric-parameter controls as the
  default fluid, with unique accessible labels for repeated fields.
- **LOX/RP-1 thruster example** — the nozzle and regenerative jacket use a
  42-station table-driven grid, and the supersonic exhaust boundary is set to
  the matched-expansion pressure. Validation figures and the central-scheme
  admissibility findings were regenerated for the refined grid.
- **Example library** — dropped the standalone regenerative-cooling-channel
  and choked-CD-nozzle examples. Regenerative cooling and the choked nozzle
  now live only in the LOX/RP-1 thruster (combustor), which already couples
  both to a CEA reacting junction. Twelve shipped examples remain.
  Benchmark names no longer lead with GFSSP or SINDA/FLUINT; the citation
  is on the canvas note (e.g. "Reference: GFSSP Figure 10").
- **Real-fluid performance report** — re-measured on the current solver
  (limited-upwind faces, real-fluid transonic `[P, ṁ, h]`). Analytic Jacobian
  still dominates CoolProp cost; the report now measures and documents the
  implemented bounded fused value caches. Regenerable via
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

[Unreleased]: https://github.com/OpenFLUME/OpenFLUME/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/OpenFLUME/OpenFLUME/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/OpenFLUME/OpenFLUME/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/OpenFLUME/OpenFLUME/releases/tag/v0.1.0
