# Extensibility and User Code

The extension surface has three levels: declarative branch models, trusted JavaScript branch models, and declarative solve logic/controllers. Prefer a declarative model when it can represent the hardware.

## Local Workflow

```bash
npm run serve
```

This builds the app and starts the local companion server, normally at
[http://127.0.0.1:4174/](http://127.0.0.1:4174/). Use `npm run serve:dist` to serve an existing build.

Alternatively, for UI development with hot-module reload, run the companion
server in one terminal (`npx tsx scripts/serve.ts`, or `npm run serve:dist`
if you also want it to serve a build) and `npm run dev` in another, then open
[http://localhost:5173/](http://localhost:5173/). The Vite config proxies `/api` to the companion
server on port 4174, so both must be running for the component library to
load in dev mode.

The server exposes `GET /api/library` and recursively scans `library/components/` (or `LIBRARY_DIR`) for `*.component.js`. Other files are ignored. Scans are bounded (256 KiB per file, 256 files, 4 MiB aggregate). Skipped files are listed in an optional `warnings` array on the response. Each file is a self-contained script with no imports or exports and must call the injected `defineComponent` function. Subdirectories are allowed. `metadata.name`, not the path, is the key used by network branches.

The left sidebar has a dedicated **Custom components** section. Use **New component** to open the structured authoring form: enter metadata, parameter definitions, and the bodies of `pressureDrop(args)` and optional `heat(args)`. The app validates and previews the generated source, then asks the companion server to create the `.component.js` file. Newly created components appear as named palette tools and are activated immediately. Connect two nodes to place an instance with the declared parameter defaults. The server refuses to overwrite an existing file.

## Declarative Components

Use these before executable code:

```json
{
  "type": "dpTable",
  "points": [
    [-1, -10000],
    [0, 0],
    [1, 10000]
  ],
  "extrapolate": "linear"
}
```

`dpTable` linearly interpolates pressure drop against mass flow. It requires at least two finite `[mdot, dP]` points with strictly increasing `mdot`. `extrapolate` is `"clamp"` by default or `"linear"`.

```json
{ "type": "customResistance", "k": 2.5, "area": 0.0001 }
```

```json
{
  "type": "customResistance",
  "k": {
    "kTable": [
      [0, 8],
      [10000, 3],
      [100000, 2]
    ]
  },
  "area": 0.0001,
  "diameter": 0.01128
}
```

`customResistance` uses `dP = K mdot |mdot| / (2 rho A^2)`. `K` may be a finite non-negative constant or a piecewise-linear `[Re, K]` table. A table requires strictly increasing non-negative Reynolds numbers, non-negative K values, and a positive `diameter` for the Reynolds-number length scale.

## User Components

A network embeds source under `componentLibrary`; a branch references its key:

```json
{
  "componentLibrary": {
    "my-k": {
      "format": "defineComponent",
      "code": "defineComponent({ metadata: { name: 'my-k', params: [{ name: 'K', default: 2 }] }, pressureDrop(args) { const A = args.area ?? 1e-4; return args.params.K * args.mdot * Math.abs(args.mdot) / (2 * args.rho * A * A); } });"
    }
  },
  "branches": [
    {
      "id": "loss",
      "from": "in",
      "to": "out",
      "component": {
        "type": "userComponent",
        "component": "my-k",
        "area": 0.0001,
        "params": { "K": 3 }
      }
    }
  ]
}
```

The current contract is:

```js
defineComponent({
  metadata: {
    name: "my-k",
    label: "My resistance",
    params: [
      { name: "K", label: "Loss coefficient", unit: "1", default: 2, min: 0 },
    ],
  },
  pressureDrop(args) {
    return 0;
  },
  heat(args) {
    return 0;
  }, // optional
});
```

`pressureDrop` must return a finite number in Pa. Its frozen `args` contains:

| Name           | Meaning                                              |
| -------------- | ---------------------------------------------------- |
| `mdot`         | Signed mass flow, kg/s                               |
| `rho`          | Density, kg/m3                                       |
| `mu`           | Dynamic viscosity, Pa s                              |
| `t`            | Solver time, s                                       |
| `T`            | Optional upstream temperature, K                     |
| `pFrom`, `pTo` | Optional endpoint pressures, Pa                      |
| `area`         | Optional branch area from the instance               |
| `params`       | Frozen numeric defaults merged with branch overrides |
| `fluid`        | Read-only accessor for this branch's working fluid   |

The class-agnostic `fluid` accessor provides `density(P,T)`, `viscosity(P,T)`,
`cp(P,T)`, `cv(P,T)`, `enthalpy(P,T)`, `internalEnergy(P,T)`,
`temperatureFromEnthalpy(P,h)`, saturation enthalpy/temperature methods, and
critical pressure/temperature. It intentionally does not expose solver fluid
classes or a global registry. There is no register accessor, network accessor,
async API, or persistent component state. User components are scalar-only and
do not provide dual derivatives, so affected Jacobian columns use finite
differences. Optional `heat(args)` receives the same `fluid` accessor.

For a short one-off law, `format: "inline"` makes `code` the body of `pressureDrop(args)`, for example `return args.mdot * 1000;`. Inline entries have no declared metadata defaults or heat callback. Numeric `params` and `area` can still be supplied by the referencing branch.

## Library Examples

Four user components ship under `library/components/` (discovered by
`npm run serve`) and are also embedded in the built-in _Extension_ examples
so they run self-contained from the Examples dropdown. Ordered from simplest
to most advanced:

- `example-resistance` (`example-resistance.component.js`): basic K-factor resistance. The minimal `defineComponent` pattern uses one declared parameter (`K`), a few lines of `pressureDrop(args)`, and the `area ?? default` idiom for the optional branch area. Study this first. It is the template on which every other local component is built.
- `dome-regulator` (`dome-regulator.component.js`): dome-loaded pressure regulator. It demonstrates reading `args.pTo` (downstream pressure) to modulate valve opening proportionally against a dome-pressure setpoint. The `tanh` smoothing replaces a hard clamp so the finite-difference Jacobian stays well-behaved, a CdA floor avoids a singular closed valve, and a linear `eps` term keeps dP finite at zero flow. It shows how far a pure `pressureDrop` law can go toward control-like behaviour _without_ solver residuals. Contrast this with the built-in `regulator`, which holds its setpoint exactly through a residual constraint. A researcher studying regulator response curves can sweep `P_dome` per instance.
- `re-k-factor` (`re-k-factor.component.js`): Reynolds-dependent K-factor resistance. It demonstrates computing the Reynolds number from `mdot`, `rho`, `mu`, and the declared `diameter`/`area`, then looking K up in an inline `[Re, K]` table with clamped piecewise-linear interpolation written in plain JavaScript. This is the user-code equivalent of the declarative `customResistance` `kTable`. Study it when a K(Re) correlation or other lookup is not expressible declaratively.
- `heated-resistance` (`heated-resistance.component.js`): K-factor resistance with a `heat(args)` callback. It demonstrates the thermal API (`Tup`, `cp`) with an ε-NTU (effectiveness-NTU) model of convection from a constant-temperature wall, `Q = ε · mdot · cp · (T_wall − T_up)`, guarded so Q → 0 as mdot → 0. It mirrors the built-in `heatedPipe` thermal model and is the reference for adding heat coupling to any custom branch.

Each file is fully commented (parameters, units, and smoothing choices are
stated in the header), and each is a pure function with no module-scope
state. The shipped _Extension_ example **Cryo tank vent control (transient)**
models an LN₂ ullage with parasitic `heatInput`, logic rules that open/close a vent valve at `P_high` / `P_low` (5 psi hysteresis), and a register-following
controller that drives `valvePosition` from the `ventOpen` register (see
[Controllers](#controllers) and [Lifecycle Rules](#lifecycle-rules-and-stopping)).

## Embedding, Provenance, and Consent

On Save and Run, the UI clones the config and embeds each referenced local
component that is not already present in `componentLibrary`. Existing embedded
source is retained rather than silently replaced. This makes saved networks
self-contained. Synchronous FNV-1a hashes are used only for non-security drift
labels. Executable-code consent and remembered trust use SHA-256 over the exact
source bytes. Hashes identify content; they are not signatures or proof of
authorship. General result exports separately include a hash of the whole
config, including every embedded component source.

Validation syntax-checks embedded code without executing it. The source runs
when discovery reads a local library file and when the solver builds a context
for a referenced component. Loading JSON alone does not execute its embedded
component, but running it does. The UI prompts before accepting embedded code
that does not match a local-library source or a source hash the user previously
trusted; changing the source changes its hash and prompts again.

Newly authored/selected components also store their validated metadata beside
the source. Property editors read that descriptor and never execute embedded
source during render. Embedded entries without stored metadata (e.g. from a
hand-authored `.fn` file) remain runnable, but parameter editing is disabled
until the user explicitly updates them from the local library.

## Registers and Expressions

`registers` initializes named finite numbers. Logic assignments can update or
create registers, and final values are returned as `finalRegisters`.

> The same safe expression language also backs **static parameter bindings**
> (`{ "expr": … }` on geometry fields), **custom convection h equations**, and
> **temperature-equation solid properties**; see
> [`docs/parameter-bindings.md`](parameter-bindings.md) for those scopes. The
> scope below is the solve-lifecycle scope (with `t`, node state, etc.), which
> parameter bindings deliberately do NOT get.

Expressions support numeric and quoted string literals; `+ - * / % ^`;
comparisons `< <= > >= == !=`; `&& || !`; ternary `?:`; calls; and safe own
property access. `^` is exponentiation. Built-ins are `min`, `max`, `abs`,
`sqrt`, `exp`, `log`, `sin`, `cos`, `tanh`, `clamp`, `smoothstep`, and `pi`.
There are no assignments, arrays, arbitrary JavaScript, or dynamic property
indexing.

The event scope can include `t`, `dt`, `iter`, and `residual`, plus:

- `node('id').P`, `.T`, `.rho`; real-fluid nodes may also expose `.h` and `.quality`
- `branch('id').mdot`
- `solid('id').T`
- `reg('name')` or a register as a bare identifier

Fixed scope names win over colliding bare register names; use `reg('t')` to
read a register named `t`. Unknown identifiers, ids, registers, or properties
are errors.

## Lifecycle Rules and Stopping

```json
{
  "registers": { "accepted": 0 },
  "logic": [
    {
      "id": "stop-after-five",
      "on": "stepAccepted",
      "when": "accepted >= 4",
      "set": { "accepted": "accepted + 1" },
      "stop": true,
      "reason": "accepted-step budget reached"
    }
  ]
}
```

Rule events are `init`, `stepStart`, `stepAccepted` (the default),
`stepRejected`, `converged`, and `solveEnd`. Rules run in declaration order.
All right-hand sides in one rule see that rule's pre-assignment state and are committed together. Later rules at the same event see earlier rules' writes.

For fixed stepping, every candidate is marched and `stepAccepted` fires after the state is recorded. For adaptive stepping, `stepStart` fires for every trial. Its writes are speculative. Rejection restores the pre-trial registers, and then `stepRejected` fires against the last accepted physical state. Only `stepAccepted` observes and updates persistent accepted state. A forced accept at `dtMin` is accepted, not rejected.

When a fired rule has `stop: true`, the solver exits at the next safe point.
Results set `userTerminated`, include `terminationReason`, and contain only the accepted trajectory. A `stepAccepted` stop includes that step, while a `stepRejected` stop ends at the previous accepted state. `solveEnd` still fires. Steady solves use `stepAccepted` for iteration progress, while transient events carry the timing semantics above.

## Controllers

Controllers are transient-only. Two types are supported:

### PID (`type: "pid"`)

Runs on `stepAccepted` (default):

```json
{
  "controllers": [
    {
      "id": "flow-control",
      "type": "pid",
      "sense": { "kind": "branch", "id": "outlet", "quantity": "massFlow" },
      "setpoint": 0.1,
      "gains": { "kp": 0.5, "ki": 0.2, "kd": 0 },
      "output": { "kind": "flowRate", "id": "source" },
      "limits": { "min": 0, "max": 0.2 },
      "initialOutput": 0.05
    }
  ]
}
```

Node senses are `pressure`, `temperature`, or `density`, and branch sense is `massFlow`. Targets are `valvePosition` on a valve, `flowRate` on a flowSource, `boundaryPressure` or `boundaryTemperature` on a boundary node, and `heatInput` on a fluid or solid node. The law is `u = kp e + ki integral(e dt) + kd de/dt`, with backward-Euler integration, zero derivative on first execution, and optional output clamping. There is no anti-windup. `initialOutput` is clamped and applied at t=0, so it affects the first step. Later outputs are computed from an accepted state and affect the next step. Once written, an override wins over a configured schedule.

### Register follower (`type: "register"`)

Runs on `stepStart` (default), after logic `stepStart` rules and before the
candidate solve. Copies a named register value directly to an actuation target
(bang-bang or scheduled actuation from logic):

```json
{
  "controllers": [
    {
      "id": "ventActuator",
      "type": "register",
      "register": "ventOpen",
      "output": { "kind": "valvePosition", "id": "vent" },
      "limits": { "min": 0, "max": 1 }
    }
  ]
}
```

Pair with logic rules on `stepStart` that set the register from hysteresis
conditions (e.g. open when `node('tank').P > P_high`, close when below
`P_low`).

Final outputs are returned as `finalControllerOutputs`.

## Fluid Scope and Forward Compatibility

User component args expose evaluated scalar state plus a branch-scoped, class-agnostic fluid accessor for that branch's continuum. In a multi-fluid network the accessor is the named fluid assigned to the branch endpoints. Do not assume an implicit global fluid or encode access to internal fluid classes. Saved component source does not change when a branch is retargeted onto another same-class continuum.

## Security Model

The expression language is parsed and evaluated without `eval` and only sees
the supplied scope. User component JavaScript is different: it is compiled
with `new Function` in strict mode. Frozen args and omitted imports reduce
accidental coupling but do not form a security sandbox; browser globals remain
reachable. The local server binds loopback by default. It blocks path traversal and symlink escapes for both library discovery and static files. It restricts writes to exclusive creation of slug-named component files with a size-capped, time-limited request body. If the server is bound to a non-loopback interface, the creation endpoint is disabled unless `ALLOW_REMOTE_WRITES=1` is set. Those controls do not make component source safe. Treat local and embedded components exactly like source code. Review them, version them, and execute only code you trust.
