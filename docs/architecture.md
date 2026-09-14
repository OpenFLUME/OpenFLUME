# Architecture

## Status and scope

OpenFLUME is currently a private npm application. `private: true` is intentional; no npm package export or
`.npmignore` policy is needed until a supported distribution is designed.

The product is a browser editor and solver with an optional local companion
server. Research validation material informs numerical confidence but is not a
runtime dependency or a promise that every research configuration is a
supported product workflow.

The physical scope is lumped-parameter network flow. Branch momentum is an
algebraic pressure-drop relation by default. With `settings.momentumFlux` and
`settings.kineticEnergy` enabled, the solver closes quasi-1-D compressible
duct flow (Fanno friction choking, Rayleigh thermal choking, seeded
converging–diverging nozzles) for any fluid model; sonic physics at
restrictions is also available as point closures (`orifice` with $Y(r,\kappa)$,
`cavitatingVenturi`). Supersonic shock capture, Rankine–Hugoniot jumps, and
distributed acoustic wave propagation (water hammer) are out of scope;
`docs/user-manual.md` §1.7 "Scope Boundaries" is the authoritative list.
Features that would
require a resolved compressible momentum equation or a shock-capturing
discretization are a solver-class change, not an incremental component.

## Development rules

The following sections define requirements for contributing to this project. They describe the conventions for structuring and modifying the solver.

### Dependency direction

Dependencies should point inward:

1. `src/core` owns schemas, fluid/component models, validation, and solvers. It
   must not depend on React or UI state.
2. `src/ui` adapts core types and results to editing, persistence, workers, and
   presentation.
3. `src/ui/solverWorker.ts` is a transport boundary around core validation and
   solving; it should not contain solver physics.
4. `src/App.tsx` and `src/main.tsx` compose the browser application. The
   shipped chrome is `StudioShell` (`src/ui/shell/studio/`): a docked project
   outline, center workspace tabs (Model, Setup, Sweep, Results), and a
   selection-mounted inspector. Shared chrome (command palette, tab strip)
   lives in `src/ui/shell/`. Manual run start/cancel goes through
   `src/ui/runController.ts`.
5. `scripts` may consume application contracts for local tooling, but runtime
   modules must not depend on scripts.
6. `src/validation` and validation data evaluate scientific claims; production
   solver code must not import fitted outcomes or test data from them.

These rules are enforced by `no-restricted-imports` in `eslint.config.js`
(core → ui/substrate/validation/frameworks, substrate/validation → ui,
ui → core internals other than the barrel, anything → scripts). A core test
that needs a UI fixture is a UI-tier test and lives in `src/ui/tests`.

### Public API and internal APIs

The supported source-level API is the export surface in `src/core/index.ts`, especially `NetworkConfig`, validation, solver entry points, result types, and documented fluid/component constructors. `DynamicCheckValve` is currently exported from `src/core/components` rather than that barrel; treat constructing it as a `NetworkConfig` component as the supported path.

Direct imports from core implementation files, diagnostics, closure internals, dual-number paths, and validation modules are internal. You should treat exports used for diagnostics, research, continuation, low-level state steps, or user-code compilation as advanced. These APIs may evolve with the solver. Browser consumers should normally use the worker client rather than running solvers on the main thread.

### Test tiers

- `npm test` uses `vitest.fast.config.ts` to run core, UI, and companion-server tests, excluding the current filename-based scientific, benchmark, chilldown, two-phase, and real-fluid suites listed in that config. CI runs it in the `check` job on every pull request, alongside lint, format, typecheck and the production build.
- `npm run test:all` discovers all Vitest files, while existing `describeSlow` blocks remain skipped. CI runs it on every pull request (`scientific-validation`), together with `check:fluid-catalogue` so a `coolprop-wasm` bump cannot ship a stale generated catalogue.
- `npm run test:slow` sets `RUN_SLOW=1` and runs all Vitest files, including expensive opt-in sweeps and convergence studies. CI runs this form on pushes to `main` and on the weekly schedule, not on pull requests.
- `npm run test:e2e:smoke` runs a focused Chromium browser spec against an existing production build.
- `npm run test:e2e` builds first and then runs the complete Playwright suite, making the command self-contained on a clean checkout. CI instead downloads the `dist` artefact the `check` job built and runs the suite in four shards against it, with the Playwright browser cached between runs.

The demo deploy (`deploy.yml`) is triggered by a successful CI run on `main`, never directly by the push, so a red `main` cannot reach the published site.

Exclusions are file based rather than test-name filters so suite membership is
reviewable and stable. New expensive scientific files should be added to the
fast exclusion list deliberately.

### Research and product boundary

Validation corpora, literature comparisons, calibration studies, and
high-cost parameter sweeps establish evidence and expose limitations. They
must not silently tune runtime defaults to a single experiment. Product
defaults require broad physical justification, regression coverage, and clear
failure behavior. Published-reference accuracy is scoped to the documented
configuration and assumptions, not a general certification claim.

### Multiple fluids

A network has one required default `fluid` plus optional named extras in
`fluids`. A node owns its fluid (`nodes[].fluid` names an extra, or omitted
means the default); a branch inherits from its endpoints and may connect two
nodes only when they resolve to the same named fluid. Unlike fluids do not mix
at a junction — the only allowed coupling is heat through solids. EOS classes
may differ between continua. Further multi-fluid work should keep fluid-property
access explicit in solver context, avoid hidden global fluid state, and move
user-component fluid access, conservation equations, worker serialization,
validation, and result provenance together.

## Configuration lifecycle

`NetworkConfig` is the persisted model contract. Configurations are created by
the editor (canvas, table, or the text projection of
`src/substrate/textProjection.ts`) or loaded from a `.fn` text file,
normalized by UI persistence helpers
where needed, validated before solving, and structured-cloned into the solver
worker. The solver builds runtime context and mutable solve state without
mutating the saved model. Results are separate objects; editing invalidates
stale results.

`meta.version` is the schema version marker (currently 2, the only accepted
version). Changes to persisted fields must update validation, examples,
tests, and the schema documentation in `docs/user-manual.md` §3 "Data
Structure", which is authoritative for field names, types, and constraints.
A breaking persisted change requires
an explicit migration strategy before the version is advanced.

## Simulation variants

`config.variants` holds named alternatives to the network in the file, each a
sparse patch rather than a copy, so base edits keep flowing into every variant
that does not override them. `src/core/variants.ts` owns the two pure
functions, which are exact inverses over the shapes the editor can produce:

- `applyVariant(base, spec)` — removals, then field overrides, then additions;
  `variants` is stripped from the output, so a resolved config is an ordinary
  solvable model and the solver never learns variants exist. Patch targets the
  base no longer has are skipped and reported, never thrown: base edits and
  variant patches are authored independently, so dangling references are
  ordinary and must not prevent a model from opening.
- `diffVariant(base, resolved)` — the inverse, used to record edits made while
  a variant is active. Every top-level key the editor can change is
  representable: `settings` field-wise, `fluid` whole, the remaining document
  fields whole via `patch.fields`, and the four entity arrays per element.
  Deletions are recorded as `null` (JSON-safe; `null` is otherwise illegal in
  a config). `meta` is the one exception — it names the file, so it always
  edits the base.

The UI keeps this split in one place. `store.baseConfig` is the file (base
network plus variant list) and is what the `.fn` text, Save, and the autosave
all describe; `store.config` is the resolved active variant and is what every
panel, the canvas, and the solver read, so the variant machinery costs the
~59 existing `useStore` subscribers nothing. `commitConfig` routes an edit to
the base or into the active variant's patch depending on which is active, and
while a variant is active it re-derives `store.config` from the recorded patch
rather than trusting the edited object, so the invariant
`config == applyVariant(baseConfig, activeVariant)` holds after every commit
and an unrepresentable edit can never be displayed as though it were saved.

Variants are authorship, not numerics: they are excluded from the provenance
hash (like `notes`), so adding one cannot stale another's results. Entity
array ORDER is excluded from that hash for the same reason — two configs that
differ only in the order elements are listed describe the same network, so
reordering the project outline must not invalidate a pinned baseline.

Results are scoped to the model that produced them: each `RunRecord` carries a
`variantId`, the ring-buffer cap applies per variant, and every wholesale model
replacement clears the history. Ownership is captured when a run STARTS
(`runController.ts` snapshots `activeVariantId` and `store.documentToken`
alongside the config), not when it completes: a solve is asynchronous and the
user may switch variants or load another model meanwhile. A completion whose
variant is no longer active is filed silently under its owner; one whose
document has been replaced is dropped rather than written into the new
document's history. Results are not written to the `.fn` file —
`src/ui/runsFile.ts` mirrors them into localStorage and exports a portable
`<model>.runs.json` sidecar. The mirror is keyed on `store.documentToken` (a
session identity minted on wholesale replacement and persisted beside the
autosave), not on the config hash: the hash moves on every edit while the
mirror is rewritten only when the history changes, so keying on it lost the
history after any run → edit → reload. Each record still carries its own
hash, so restored runs show as stale exactly as they would when selected live.

## Text projection (src/substrate)

`src/substrate/textProjection.ts` is the bidirectional text projection of
the canonical `NetworkConfig`: `serializeText` renders a config as a
line-oriented `.fn` document and `parseText` parses one back. It exists so a
network is a reviewable, diffable, hand-editable text artifact rather than an
opaque JSON blob.

- Layering: the substrate depends on `src/core` (the schema plus the `decodeNetworkConfig` / `validateNetwork` boundary pipeline, which it runs after structural assembly) and never on `src/ui`. The UI consumes it (the `.fn` save/load path and the Text tab) through `serializeText` / `parseText`, so the format stays usable from any host, including Node.js tooling.
- The `.fn` save format uses one record per line (`network`, `node`, `solid`, `branch`, `conductor`, `group`, `note`, plus singleton field lines — `settings`, `fluid`, `fluids`, `closureParams`, `species`, `registers`, `logic`, `controllers`, `junctions`, `componentLibrary`, `variants`), LF newlines, and strict JSON for all values and data payloads. The projection is lossless: parsing serialized output reproduces the config exactly, including canvas geometry, group membership, and the absent-vs-empty distinction for the optional entity arrays. Fluid and solid `@ (x, y)` coordinates are canvas pixels. Physical metres live in `position {x,y,z}` inside the data payload (a legacy third `@` coordinate is still accepted as `position.z`). Parsing is strict and never throws: malformed input yields `ParseError` entries with line numbers and a `stage` (`syntax` / `decode` / `validate`), and decode/validation failures are attributed to the offending line where possible.
- Two boundaries come out of one parse. `ParseResult.document` is the EDITING boundary: present when the text decodes to a `NetworkConfig` whose ids are unique and whose element references resolve (`validateReferences`), regardless of whether the solver would accept it — a saved model with no boundary node yet must reopen, because Save never refused to write it. `ParseResult.config` is the SOLVING boundary: present only when there are no errors at all. File load (`parseModelFile`) uses the former and the editor surfaces the remaining validation issues; the Text tab and every solve path use the latter.
- Current limitation: the text is SI-only; numbers are always written and read in raw SI units with no unit labels. The `preset` option exists for UI unit-preset compatibility but is accepted and ignored, so SI values round-trip bit-exactly regardless of the display preset.

## Solver worker

Steady and transient browser solves run in a Vite module worker. The client
sends a cloned config and mode; the worker validates, initializes CoolProp on
demand, emits throttled progress, and returns a result or error. Each solve
spawns exactly one worker, terminated on every settle (done / error / crash)
as well as on cancellation, so no idle workers accumulate; late messages from
a terminated worker are ignored. This boundary protects UI responsiveness, not
security.

Implementation details worth knowing before changing this path:

- Spawn form. The worker is created Vite-natively as
  `new Worker(new URL('./solverWorker.ts', import.meta.url), { type: 'module' })`,
  which is what makes `vite build` emit it as a separate chunk rather than
  inlining it. Keep the literal `new URL(..., import.meta.url)` argument;
  hoisting it into a variable defeats Vite's static analysis.
- Cancel message. The worker still recognizes `{type:'cancel'}`, even though
  the UI path never relies on it: because the solve loop is synchronous and the
  app avoids `SharedArrayBuffer` (which would require cross-origin isolation
  headers), the client terminates the worker and respawns instead. Treat the
  handler as a contract for non-UI hosts, not dead code.
- CoolProp. The dynamic `coolprop-wasm` import resolves under both `vite dev`
  and `vite preview` because Vite serves the co-located `.wasm` beside the
  worker chunk. Initialization is gated by the `networkUsesRealFluid`
  predicate and happens once per worker rather than once per substance, so a
  network that never touches a real fluid never pays for the sidecar. The
  worker is the ONLY context that loads CoolProp: the main thread has no use
  for the properties, and the health pill's "Loading fluid properties…" state
  is driven by the worker's `coolpropLoading` message, not by a second
  instance.
- Protocol. `src/ui/workerProtocol.ts` holds the `MainToWorkerMessage` /
  `WorkerToMainMessage` unions both sides compile against; the client narrows
  received data through `parseWorkerToMainMessage` before acting on it.
- Embedded components. The whole config is structured-cloned to the worker,
  including any `componentLibrary` source. Validation only syntax-checks that
  source; referenced definitions actually execute when the worker builds
  solver context. This is the trust boundary described under Extension trust,
  not a sandbox.

## Exploration sweeps (session-only)

The Sweep workspace (`src/ui/sweep/` + `src/ui/components/SweepPanel.tsx`) is a
shipped, session-only parameter-sweep UI with a deliberately narrow trust
boundary:

- A second, session-only zustand store (`sweep/store.ts`) owns sweep jobs. Its
  only read of the canonical store is the config snapshot taken at job
  creation (a deep-frozen `structuredClone` with an FNV hash); its only write
  back is the explicit Promote action, which creates a named simulation
  variant carrying the swept field as its patch and files the promoted run
  under it. Running a job never touches the model, text buffer, undo history,
  or localStorage, and no job state is persisted.
- Execution is strictly sequential through a generic, job-kind-agnostic solve
  queue (`sweep/runner.ts`): one worker per variant, per-variant
  status/result/error recording, continue-after-failure, and
  generation-guarded cancellation so a late settle can never flip a cancelled
  job back to done.
- Manual Run and a sweep are mutually exclusive in both directions (toolbar
  and store boundary checks, backed by the shared worker client rejecting a
  concurrent run).
- Both paths pass through the same preflight (`src/ui/runPreflight.ts`):
  embedded-component trust, local-component embedding (manual) or an
  un-embedded-component error (sweeps, whose variant configs are hash-pinned
  at creation and cannot be rewritten), then semantic validation. A sweep job
  whose frozen base fails preflight is marked failed before any worker is
  spawned. Embedded user code executes as trusted code in the worker, so no
  path may reach it without this gate.

Future optimization seam: the queue already accepts an injected client
factory and any unit source, so a warm-worker pool (avoiding per-variant
CoolProp reloads for realFluid sweeps) or a non-sweep job kind (e.g.
optimization) can be added without changing job lifecycle semantics.

## Convergence diaries

`src/ui/convergenceDiary.ts` is a pure, store-free domain core that turns the evidence already crossing the worker boundary (the throttled progress callbacks plus the final `SteadyResult`/`TransientResult`) into a bounded, deterministic, wall-clock-free `RunDiary`. No solver instrumentation was added: steady events are gated on residual-decade crossings, transient events on end-time quartiles and observed dt changes, and outcomes are derived strictly from result flags (`converged`/`aborted`/`userTerminated`, end-time reached). As a result, the diary can explain but never contradict the result.

- Retention is hard-capped (`DIARY_EVENT_CAP`, 200) with a tiered eviction policy (lifecycle anchors and warnings outlive routine info) and exact accounting: `emitted = retained + dropped + coalesced` always.
- One diary session exists per manual run (`runDiarySession.ts`, wired in the toolbar's run/cancel callbacks). First-finalize-wins across the done/error/rejection races, the cancel guard turns any post-cancel settle into a partial _cancelled_ diary, and preflight validation/trust failures happen before a session exists, so they produce no diary. Sweeps create one collector per variant under the same generation guard as results.
- `store.ts` holds the displayed result's diary (`resultDiary`) next to `result`/`resultConfig`. Run push/selection attach the record's deep-cloned diary, cancelled/errored runs attach a partial diary with no fabricated run record, and model edits leave the stale result's diary untouched (following the same rule as the result itself).
- Presentation/export share one pure formatting core (`diaryPresentation.ts`). The Analysis _Solver diary_ section, the run-history diary affordance, and the sweep variant cell render the same labels. JSON/text exports are sanitized, deterministically ordered, and carry config-hash provenance.

Deeper-instrumentation seam: when richer solver telemetry is justified, the seam is the collector's `onProgress`/`finalizeFromResult` input contract: new event kinds can consume new fields on the worker progress/result messages without touching retention, session lifecycle, or presentation.

## Extension trust

Declarative tables and parsed expressions have constrained contracts. Embedded
or local JavaScript user components are different: they execute as trusted
code and can consume CPU or access capabilities available in their execution
environment. Source consent and worker execution reduce accidental risk but
are not a hostile-code sandbox. See [Security](../SECURITY.md).
