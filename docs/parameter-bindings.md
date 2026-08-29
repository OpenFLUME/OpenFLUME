# Parameter Bindings, Convection Models, and Solid Property Models

# User-facing reference for the three property-panel features on top of the plain numeric schema fields:

1. Formula bindings: geometry-like fields may hold `{ "expr": "…" }` instead of a literal SI number.
2. Convection heat-transfer models: constant h, named correlations, or a custom h equation on convection conductors.
3. Solid property models: cp and conduction k as constants, built-in materials, temperature tables, temperature equations, or time tables.

All three are plain data in the network config. They round-trip through the text format and JSON saves unchanged, and every UI edit is one ordinary undoable config change.

---

## 1. Formula bindings (`{ "expr": "…" }`)

Selected geometry-like fields accept a formula object instead of a literal
number:

```json
{
  "id": "c1",
  "from": "w1",
  "to": "f1",
  "type": {
    "kind": "convection",
    "h": 1000,
    "area": { "expr": "pipe('b_in').surfaceArea" }
  }
}
```

In the property panel, click the **f(x)** button on any formula-capable field (marked with a small `ƒ?` hint icon) to open a config-aware picker of valid model references and helpers. A literal field enters formula mode automatically and the picked item is inserted at the caret. A bound field shows an **ƒ formula** badge, keeps the expression editable (the source is shown with an `=` leader, e.g. `=pipe('seg1').surfaceArea`), and displays the resolved value in the current display unit (`→ 0.152 m²`). Errors (parse, unknown id, dependency cycles, non-positive geometry) are shown inline without deleting the formula. **Use resolved value** replaces the formula with its current literal number.

### Visual editor (chips + autocomplete)

Formula fields edit the source in a token editor. Complete model references render as inline **chips** (`b_in · surfaceArea`) while helpers, builtins, operators and numbers stay plain text. The underlying source string remains authoritative and byte-exact: chips are just a rendering of it.

- Autocomplete opens as you type (or via `Ctrl+Space` or the **f(x)** button): accessors, helpers and builtins at the top level; ids inside `pipe('…')`-style calls; properties after a dot. `↑`/`↓` move, `Enter`/`Tab` accepts, `Esc` closes. Accepted suggestions insert valid source and become chips immediately. Clicking **f(x)** on a literal field enters formula mode and opens the picker immediately. While editing a formula it reopens the menu at the current caret (or the append position).
- Chip editing: click a chip to select it, then `Backspace`/`Delete` removes its whole source span. `Enter` explodes it back to raw editable text (double-click does the same), or type to replace it. `Backspace` / `Delete` next to a chip also removes it atomically, and every chip has a `×` remove button.
- A chip that no longer resolves (renamed id, out-of-scope property) shows a dashed red warning style: the source and the inline error are unchanged, and the field still commits/edits normally.
- Prefer plain text? The **Aa (Text formula)** toggle next to the field is an optional escape hatch that switches to a plain-text input (no chips, no autocomplete) and back at any time. Both edit the same source. Literal number entry is identical in both modes.

### Semantics

- Formulas are written in the [safe expression language](usercode.md#registers-and-expressions) (hand-written parser, no `eval`), with values in **SI units**.
- They are resolved **once against the static model** at validation/solve entry, never inside a Newton iteration or transient step, so a binding cannot feed solver state back into the Jacobian. There is deliberately **no `t`, no P/T/ṁ state, and no schedule access** in scope.
- The solver receives an immutable resolved clone. Your model keeps the formula objects.

### Static scope

| Accessor           | Properties (all SI)                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `pipe('id')`       | `length`, `diameter`, `roughness`, `elevationChange?`, `area`, `volume`, `surfaceArea`                  |
| `heatedPipe('id')` | pipe set plus `ua`, `wallTemperature`                                                                   |
| `bend('id')`       | `diameter`, `angle`, `rOverD`, `roughness?`, `area`                                                     |
| `branch('id')`     | the component's stored numeric properties (any branch type; no derived values)                          |
| `node('id')`       | `volume?`, `pressure?`, `temperature?`, `heatInput?`, `position.{x,y,z}?`, `z?` (alias of `position.z`) |
| `conductor('id')`  | stored numeric fields (`area`, `length`, `h?`, `correlation.diameter`, …)                               |
| `solid('id')`      | `mass?`, `temperature`, `heatInput?`, `position.{x,y,z}?`                                               |
| `reg('name')`      | initial register values (logic-rule writes during a solve are not visible)                              |

Helpers: `circleArea(d)`, `circleDiameter(a)`, `cylinderVolume(L, d)`,
`cylinderArea(L, d)`, plus the expression builtins (`min`, `max`, `sqrt`,
`exp`, `log`, …, `pi`). Ids must be string literals: `pipe('seg1')`, never
`pipe(name)`.

### Bindable fields (v1 allowlist)

Fluid-node `pressure`/`temperature`/`volume`/`heatInput`; solid-node
`temperature`/`mass`/`heatInput`; every fluid/solid physical-coordinate axis
`position.{x,y,z}`; `pipe`/`heatedPipe` `length`/`diameter`/`roughness`/
`elevationChange` (+ `ua`/`wallTemperature` on heated pipes); `bend`
`diameter`/`rOverD`/`roughness`; `orifice` `area`/`cd`;
`valve` `area`/`cd`/`position`; `checkValve` `area`/`cd`;
`dynamicCheckValve` `area`/`cd`/`discArea`/`mass`/`springRate`/`preload`/
`damping`/`stroke`/`initialPosition`; `reliefValve` `crackPressure`/
`fullOpenPressure`/`area`/`cd`; `cavitatingVenturi` `throatArea`/`cd`/
`recoveryFactor`; `areaChange` `areaIn`/`areaOut`; `flowSource` `massFlow`;
`regulator` `setPressure`/`maxCdA`; `customResistance` `area`/`diameter`;
`userComponent` `area`; `resistance` `k`/`area`; conductor `area` (all kinds),
conduction `length`, convection `h`, radiation `emissivity`/`viewFactor`, and
numeric convection-correlation fields (`diameter`, `flowArea`, `axialPosition`,
`inletLiquidReynolds`, `segmentLength`, `frontEnergyFactor`,
`rewetHysteresisOffsetK`). Geometry derivation runs after coordinate
formulas resolve. Schedules, controller values, material properties, enum
keys, and runtime expressions remain separate.

Formulas may reference other bound fields (dependency cycles are reported as
readable errors). Formula-bound fields cannot be sweep targets directly;
sweep the referenced literal field instead.

---

## 2. Convection heat-transfer models

A convection conductor is `Q = h·A·(T_solid − T_fluid)`. The property panel's **Heat-transfer model** selector chooses how `h` is obtained:

| Model                              | `correlation.model`                       | What it is                                                                                                                                              |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Specified h (constant or equation) | _(no `correlation` block, or `"custom"`)_ | You supply h (the default).                                                                                                                             |
| Dittus–Boelter                     | `"dittusBoelter"`                         | Single-phase turbulent forced convection, Nu = 0.023·Re^0.8·Pr^0.4.                                                                                     |
| Miropolskii film boiling           | `"miropolskii"`                           | Film boiling with quality/density-ratio correction; DB fallback when single-phase.                                                                      |
| Darr–Hartwig chilldown             | `"darrHartwig"`                           | LH₂ chilldown regime map (NB/TB/FB); needs `axialPosition`.                                                                                             |
| TT-WF chilldown                    | `"ttWf"`                                  | Proposed two-temperature/wetted-fraction closure; needs `axialPosition` + `segmentLength`, transient mode, and a solid wall endpoint with thermal mass. |

The block lives inside the conductor's `type` object, beside `area`:

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

This is backward compatible in both directions: omitting `correlation` leaves the legacy constant-`h` conductor exactly as it was, and adding it makes `h` optional on that conductor.

When a named correlation is active, `h` becomes the documented **fallback floor** (used when the correlation cannot evaluate; a 5 W/m²·K floor applies when no `h` is given). The panel exposes the geometry inputs the model needs: `diameter` (required for the named models), optional `flowArea` (defaults to π·D²/4; `G = ½·Σ|ṁ|/flowArea` at the fluid node), and `axialPosition` (distance from the pipe inlet; required to run Darr–Hartwig or TT-WF, including when those models are selected later in a sweep). The panel shows this field for every correlation so `z` can be set before a sweep. If it is left unset and the connected pipes form a unique simple path with physical `position` coordinates, validation/solve fills it from that path (solid `position.x − origin.x` when both exist, otherwise the fluid-node station). A tee or other non-unique graph is not guessed. Diameter and flow area are formula-bindable.

Model suitability is shown inline in the panel. The named models require the `realFluid` fluid model. Darr–Hartwig's fit envelope is LH₂ vertical upflow. TT-WF is research-status and transient-only. `core/validate.ts` remains the authority: invalid combinations are reported as validation issues.

### Specified h: constant or equation

The **Specified h** entry has one input box and accepts all three of these. Which one you get follows from what the equation reads, not from a second menu:

| Typed                                                                         | Stored as                                      | Evaluated                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| `100`                                                                         | `h: 100`                                       | never (it is the value)      |
| an equation over the model, e.g. `reg('hScale') * 50`                         | `h: { expr }`                                  | once before each solve (§1)  |
| an equation over the local flow state, e.g. `0.023 * Re^0.8 * Pr^0.4 * k / D` | `correlation: { model: "custom", expression }` | by the solver, per h refresh |

An equation is treated as the runtime kind when it reads at least one identifier of the scope below and nothing from the model scope. Anything else is a static binding, including a mixed or misspelled equation. This way an unresolvable name is REPORTED as a binding error rather than falling back to the h floor in silence. Writing an equation clears the stored `h`, so the box is the only place h comes from; use `max(…)` for a floor of your own.

### Runtime h equation scope

`model: "custom"` compiles `correlation.expression` once per solve and refreshes h at attempt start and each **outer** iteration (under-relaxed ×0.5, frozen inside the inner Newton, same cadence as the named models):

```json
"correlation": {
  "model": "custom",
  "expression": "0.023 * (G * D / mu)^0.8 * (cp * mu / k)^0.4 * k / D",
  "diameter": 0.03,
  "params": { "scale": 1.0 }
}
```

Scope (all SI): `t`, `Tf`, `Tw`, `P`, `G`, `D`, `area`, `flowArea`, `rho`,
`mu`, `k`, `cp`, `Pr`, `Re`, `quality`, `param('name')` / `params.name`, plus
the builtins. Fluid-dependent identifiers exist only when the fluid model
carries them (legacy models have no `k`, so `Pr` is absent there); an
expression that needs a missing quantity falls back to the floor. `custom`
does **not** require `realFluid` when it uses only generic quantities.
`params` is a JSON object of finite numbers, validated as you type.

---

## 3. Solid property models (cp and conduction k)

Solid-node `cp` and conduction-conductor `k` offer five modes in the property panel:

| Mode                 | Schema shape                                    | Notes                                                                                                                                                                              |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Constant             | `500`                                           | Legacy behaviour, unchanged.                                                                                                                                                       |
| Built-in material    | `{ "material": "ofhc-copper" }`                 | Named preset from `SOLID_MATERIALS` (OFHC copper, GRCop-84, Al 6061-T6, stainless 304/316, Inconel 718, PTFE, G-10 CR); provenance, validity range and caveats shown in the panel. |
| Temperature table    | `{ "table": [[T, v], …] }`                      | Piecewise-linear in T (K), clamped outside the knot range; ≥ 2 points, strictly increasing positive T, positive values.                                                            |
| Temperature equation | `{ "expression": "…", "tRange": [Tmin, Tmax] }` | Safe expression with `T` [K] in scope; sampled once over `tRange` into the canonical piecewise-linear curve (exact solver integration thereafter).                                 |
| Time table           | `{ "timeTable": [[t, v], …] }`                  | Piecewise-linear in time [s]; **transient only**, as the value is frozen at each accepted step's endpoint time (backward Euler); steady solves reject time tables.                 |

Mode switches are explicit, seed sensible defaults from the current value, and commit as one undo step. Core validation constraints are shown inline. Material provenance stays visible in the Material mode.

---

## Persistence

All of the above are ordinary config JSON. The text format (`docs/architecture.md`) carries `{ "expr": … }`, `correlation` blocks, and the solid property spec objects verbatim, and JSON save/load is lossless. No grammar changes were needed.
