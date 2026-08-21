# Solid Material Properties

## Material catalogue

The `SOLID_MATERIALS` registry (`src/core/solidProperties.ts`) provides named cp(T) and k(T) curves. Every curve is used only inside its published validity range. Outside that range the value is **clamped to the nearest end of the range** (constant extrapolation), never extrapolated. The Property Panel material mode shows each material's source, validity range, stated accuracy, and clamping behaviour inline.

| Registry key          | Material                                               | Range (K)            | Sources                                                                                | Caveats                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ofhc-copper`         | OFHC copper (UNS C10100/C10200)                        | 4–300                | NIST Cryogenic Material Properties Database, rev. 02/03/2010                           | k assumes RRR = 100; k is strongly RRR-dependent below ~100 K (factor ~2–5 across RRR 50–500)                                                                                           |
| `grcop-84`            | GRCop-84 (Cu-8 at.% Cr-4 at.% Nb)                      | 296–1173             | Ellis, NASA/CR-2000-210055 (NTRS 20000064095)                                          | High-temperature chamber-liner copper, not C18150 CuCrZr and not OFHC; k is the all-data regression mean, not the source's lower 95 % CI; clamped outside 296–1173 K                    |
| `aluminum-6061-t6`    | Aluminum 6061-T6 (UNS A96061)                          | 4–300                | NIST Cryogenic Material Properties Database                                            | Cryogenic range only; clamped outside                                                                                                                                                   |
| `stainless-steel-304` | Stainless steel 304 (UNS S30400)                       | 4–1600               | NIST (4–300 K) + ANL-75-55 304L correlations (≥300 K)                                  | Composite (see splice note below); ANL states 304/304L property differences are negligible                                                                                              |
| `stainless-steel-316` | Stainless steel 316 (UNS S31600)                       | 4–1600               | NIST (4–300 K) + ANL-75-55 316L correlations (≥300 K)                                  | Composite (see splice note below); above ~1200 K the ANL 316L correlations are ANL's own extrapolation toward the melting range                                                         |
| `inconel-718`         | Inconel 718 (UNS N07718)                               | 298–1375             | Agazhanov, Samoshkin & Kozlovskii, J. Phys.: Conf. Ser. 1382 (2019) 012175 (CC-BY 3.0) | High-temperature range only (clamped below 298 K); the γ″/δ transformation intervals 900–1070 K (cp) and 800–1173 K (k) are bridged linearly (no single-phase correlation exists there) |
| `ptfe`                | PTFE (Teflon)                                          | 4–300                | NIST Cryogenic Material Properties Database                                            | Cryogenic range only; clamped outside                                                                                                                                                   |
| `g10-cr-normal`       | G-10 CR fiberglass epoxy, normal (through-thickness) k | 10–300 (k); cp 4–300 | NIST Cryogenic Material Properties Database                                            | Anisotropic: k is the through-thickness direction                                                                                                                                       |
| `g10-cr-warp`         | G-10 CR fiberglass epoxy, warp (in-plane) k            | 12–300 (k); cp 4–300 | NIST Cryogenic Material Properties Database                                            | Anisotropic: k is the in-plane direction                                                                                                                                                |

Fit forms and stated accuracies are recorded per material in the registry
`provenance` block (shown in the UI) and in the source-header comments of
`solidProperties.ts`.

### NIST cryogenic fits (OFHC copper, 6061-T6, 304, 316, PTFE, G-10)

Primary source: **NIST Cryogenic Technologies Group, Cryogenic Material Properties
Database** (index page: [https://trc.nist.gov/cryogenics/materials/materialproperties.htm](https://trc.nist.gov/cryogenics/materials/materialproperties.htm)).
Underlying program: Marquardt, Le & Radebaugh, "Cryogenic Material Properties Database",
11th International Cryocooler Conference, 2000,
[https://trc.nist.gov/cryogenics/Papers/Material_Properties/2000-Cryogenic_Material_Properties_Database.pdf](https://trc.nist.gov/cryogenics/Papers/Material_Properties/2000-Cryogenic_Material_Properties_Database.pdf)
(data references for the copper curves: see the database's references page and NIST
Monograph 177, Simon, Drexler & Reed, "Properties of Copper and Copper Alloys at
Cryogenic Temperatures", 1992, [https://nvlpubs.nist.gov/nistpubs/Legacy/MONO/nistmonograph177.pdf](https://nvlpubs.nist.gov/nistpubs/Legacy/MONO/nistmonograph177.pdf)).

All NIST curves here use the database's log-log polynomial log10(y) = Σ_j a_j·(log10 T)^j, except OFHC-copper k, which uses the RRR-dependent rational polynomial log10 k = (a + c·√T + e·T + g·T^1.5 + i·T²)/(1 + b·√T + d·T + f·T^1.5 + h·T²). RRR = 100 is adopted, which is NIST's "average sample" curve; the RRR spread is a documented material uncertainty. The NIST 316 cp is two fits (4–50 K and 50–300 K) that join at 50 K with a 0.15 % step, inside their 2 % stated accuracy. NIST publishes the same k coefficients for 316 as for 304. G-10 k is anisotropic: the two registry entries carry the two published directions. The NIST k equation ranges start at 10 K (normal) and 12 K (warp), which sets those entries' stated validity range.

### Stainless-steel high-temperature extension and the 300 K splice

Above 300 K the two stainless steels use **ANL-75-55** (C. S. Kim,
"Thermophysical Properties of Stainless Steels", Argonne National Laboratory,
September 1975, DOE OSTI 4152287, [https://www.osti.gov/biblio/4152287](https://www.osti.gov/biblio/4152287))
recommended solid-region correlations (SI-converted):

- 304L: cp = 0.1122 + 3.222×10⁻⁵·T cal/(g·K); k = 0.08116 + 1.618×10⁻⁴·T W/(cm·K)
- 316L: cp = 0.1097 + 3.174×10⁻⁵·T cal/(g·K); k = 0.09248 + 1.571×10⁻⁴·T W/(cm·K)

The NIST cryogenic curves and the ANL correlations do not agree exactly at 300 K (the offsets are ~8 % for 304 cp, ~2 % for 316 cp, ~15 % for 304 k, and ~9 % for 316 k). The catalogue does **not** jump. The composite keeps the NIST value exactly at 300 K and removes the offset with a documented linear blend over 300–500 K. For T ≥ 500 K, the curve is the pure ANL-75-55 correlation. The composites are capped at 1600 K. The ANL correlations underlie data to 1620/1170 K for cp and 1600/1200 K for k for 304L/316L and are ANL's smoothed solid-region recommendations, while melting begins at 1670–1730 K.

### Inconel 718 (298–1375 K)

Source: Agazhanov, Samoshkin & Kozlovskii, "Thermophysical properties of
Inconel 718 alloy", J. Phys.: Conf. Ser. 1382 (2019) 012175 (open access,
CC-BY 3.0, [https://doi.org/10.1088/1742-6596/1382/1/012175](https://doi.org/10.1088/1742-6596/1382/1/012175)), using piecewise
correlations (the paper's eqs. (1)–(3) for cp, (9)–(10) for k) with stated
errors of 2–3 % (cp) and 3–5 % (k). No credible low-temperature cp
correlation is published for this catalogue, so the curve starts at 298 K and
clamps below. The γ″/δ phase-transformation intervals (900–1070 K for cp,
800–1173 K for k), where the source reports no single-phase correlation, are
bridged by a straight line between the branch endpoints (a documented
approximation, not measured data).

### GRCop-84 (296–1173 K)

Source: D. L. Ellis, "Thermophysical Properties of GRCop-84", NASA/CR-2000-210055 (2000), [https://ntrs.nasa.gov/citations/20000064095](https://ntrs.nasa.gov/citations/20000064095): DSC cubic for cp (eq. 12, 296–1173 K) and the all-data unweighted ln(T) regression for k (eq. 17). Companion liner context is found in Ellis, NASA/TM-2005-213566, where MCC liner k is quoted as 305–320 W/m·K. GRCop-84 is Cu-8 at.% Cr-4 at.% Nb, developed at NASA GRC for regeneratively cooled chamber liners. It is not C18150 CuCrZr and not OFHC (the `ofhc-copper` NIST curve stops at 300 K). The catalogue stores the k regression **mean**, not the source's lower 95 % confidence interval (mean − 1.860×Sy.x). Published k data start near 80 K. The catalogue range is the intersection with cp (296–1173 K), and clamps outside.

## Design

- Schema (`src/core/schema.ts`): `SolidPropertySpec = number | { table: [[T, v], …] } | { material: '<name>' }`. `SolidNode.cp` and conduction-`Conductor.k` both accept it. A constant number is also permitted. The solver keeps a separate, untouched constant code path.
- Canonical T-dependent form: piecewise-linear table in T (K), clamped at the end knots (value = endpoint, slope = 0 outside; enthalpy extends linearly with the clamped value). It was chosen because then (a) the property value, (b) its enthalpy integral H(T) = ∫ cp dT (piecewise quadratic), and (c) its slope are ALL exact for the represented curve. The solver's residual and Jacobian are exact for the discrete model with no quadrature error anywhere.
- Preset registry (`src/core/solidProperties.ts`): each `SOLID_MATERIALS` entry stores the source fit coefficients + provenance (source, URL, fit form, validity range, stated accuracy, notes; assumed RRR for OFHC copper). It samples them ONCE at module load via adaptive midpoint refinement to ≤ 1e-3 relative interpolation error (see Validation margins below). Composite curves (the stainless steels, Inconel 718) are sampled segment-by-segment (`sampleComposite`) so knots land exactly on the splice/branch temperatures. `getSolidMaterialTable(name, 'cp'|'k')` returns a copy of the knots for calibration-style probes (e.g. scaling the whole curve).
- Solver coupling (`solveThermalSubsystem`, `src/core/solver.ts`): solid storage is the **enthalpy form** `m·(H(T_new) − H(T_old))/dt`, NOT `m·cp(T̂)·ΔT/dt` at a representative T. Justification: (1) backward Euler in enthalpy is exactly energy-conserving per step for the represented curve. The per-step enthalpy release is `m·ΔH` regardless of how sharply cp collapses across the step (on a cryogenic line one step can move a wall through cp 385→150). A representative-cp form would mis-weight that integral by O(10 %) per step at the quench front. (2) The Jacobian term `m·cp(T_new)/dt` is the EXACT derivative of the enthalpy form (dH/dT = cp), so the existing exact-analytic-Jacobian Newton structure is preserved (verified entry-by-entry against central finite differences in `src/core/__tests__/solidThermalTransient.test.ts`). (3) It telescopes exactly in the constant-extraction lumped case.
- Conduction k(T): k is evaluated at the endpoint mean Tm = (Tf+Tt)/2 (standard mean-property link). The Jacobian gets the exact extra term `G'(Tm)·(Tf−Tt)/2` on both endpoint derivatives (G' is piecewise-constant from the table). For thin-wall transfer lines, axial conduction is orders of magnitude weaker than wall-to-fluid convection, so k(T) matters mainly for conduction-dominated hardware (thick walls, short links, MLI standoffs).
- Jacobian probe hook: `probeThermalSubsystem(ctx, state, {dt, prevState}, hMap?, Toverride?)`. This is the thermal analogue of the fluid-side `probeJacobians`, used by the FD guard. It shares one assembly function (`assembleThermalSubsystem`) with the Newton loop so probe and production can never drift.
- **ParaHydrogen** is included in `SUPPORTED_REAL_FLUIDS` (now the curated favorites subset of the generated 124-fluid HEOS catalogue; see `docs/fluid-catalogue.md`). A test pins both its inclusion and `OrthoHydrogen`'s exclusion from the favorites. The latter has no transport model in this coolprop-wasm build: it stays discoverable in the picker but validation rejects it with a zero-transport error.
- Validation (`validate.ts`): table specs need ≥2 points, strictly-increasing positive T, positive values. Material names are checked against the registry. Constant-cp error messages are untouched.

### Validation margins (property layer)

- OFHC copper: sampled table vs NIST fit equation is ≤ 0.097 % (cp) / 0.099 % (k) over 4–300 K. This is ~50× tighter than the fits' stated accuracy.
- OFHC NIST cp fit vs canonical handbook anchors (consistent with NIST Monograph
  177 §7-1): 10 K: 0.8566 vs ≈0.86 (−0.4 %); 20 K: 7.506 vs ≈7.5 (+0.1 %); 77 K:
  195.92 vs ≈193.5 (+1.3 %); 150 K: 324.11 vs ≈324 (+0.0 %); 300 K: 389.40 vs
  385 (+1.1 %). All within NIST's stated fit accuracy (10 % below 15 K; 5 % above).
- OFHC k fit (RRR=100): 396.3 W/m·K at 300 K; RRR spread at 20 K is a factor >2.5
  (documented material uncertainty).
- All catalogue tables reproduce their source curves to ≤ 0.2 % over the full
  validity range (enforced by tests; most are ≤ 0.1 %).
- Stainless composites: table value at 300 K equals the NIST fit (splice anchor, no jump). For T ≥ 500 K the tables match the ANL-75-55 correlations, including the report's own printed anchors at 1000 K (304L: cp 0.1444 cal/(g·K), k 0.2429 W/(cm·K); 316L: cp 0.1414 cal/(g·K), k 0.2496 W/(cm·K)).
- Inconel 718: table matches the source paper's Table 2 recommended values at
  298–800 K and 1100–1300 K to ≤ 0.1 % (the paper's 4-digit print rounding).
- GRCop-84: sampled tables vs Ellis NASA/CR-2000-210055 eqs. 12 and 17 to ≤ 0.2 % over 296–1173 K. k(550 K) ≈ 305 W/m·K (low end of the TM-2005 MCC band).

### Test inventory

- `src/core/__tests__/solidProperties.test.ts`: OFHC fit/table validation vs published values at 10/20/77/150/300 K with the stated tolerances. This test covers table mechanics (interp, clamp, exact integral, dH/dT consistency), spec validation, and registry provenance. It creates deterministic fit-value snapshots for every material. It includes catalogue table-vs-source checks (≤0.2 %) over each material's full validity range. It covers stainless 300 K splice-continuity and ANL 1000 K anchor tests. For Inconel 718, it includes source-table anchors, branch-continuity and transformation-gap bridge tests. It provides GRCop-84 Ellis fit snapshots, MCC-band k check, and clamp/provenance tests. It covers G-10 anisotropy and per-direction range tests, as well as clamp behaviour at both ends of every range. It asserts registry-wide provenance/validity-range invariants and checks OFHC non-regression.
- `src/core/__tests__/solidThermalTransient.test.ts`: thermal-subsystem Jacobian vs central FD (mixed T-dep + constant-cp network incl. clamp-region nodes); lumped-mass constant-extraction telescoping (exact) + 200 K crossing vs an independent in-test march on the raw NIST fit; Newton-cooling with cp(T) vs fit-reference and constant-cp vs exact BE recurrence; golden constant-cp bit-identity (transient traces + steady state).
- `src/ui/tests/solidPropertyField.test.tsx`: material labels for the whole catalogue. The material mode renders each material's source, validity range and clamping note. `specValueAt` honours per-material clamp ranges.
- `src/core/__tests__/realFluid.test.ts`: ParaHydrogen is supported (Tsat(74.97 psia) = 27.292 K = the para curve, matching the NBS-published saturation temperatures). OrthoHydrogen remains excluded.

### Deferred candidates

- **Ti-6Al-4V**: the NIST cryogenic page publishes only k (20–300 K). The public NASA handbook (NASA-CR-123775, "Materials data handbook. Titanium 6Al-4V", 1972) is a scanned document whose tabulated cp(T)/k(T) could not be extracted with the accuracy this catalogue requires. It is deferred rather than fabricated; the NIST k-only curve is insufficient for the joint cp+k requirement.

## Reproduce

Use `scripts/chilldown-baseline.ts` and the configurations in
`src/ui/tests/chilldownTwoPhase.test.ts` as the maintained starting point.
`getSolidMaterialTable` supports calibration-style probes (e.g. scaling the whole
cp/k curve). Golden bit-identity values live in
`src/core/__tests__/solidThermalTransient.test.ts`.
