# Documentation

This directory contains maintained product documentation for users and
contributors.

- [User's manual](user-manual.md) is the complete reference: network definitions, units and sign conventions, data structure, governing equations and component relations, solution methods, the interface, the twelve shipped example problems, and the verification record. Its interface screenshots (`figures/user-manual/`) are captured from the built application; regenerate them after a UI change with `npm run build && npx tsx scripts/capture-manual-figures.ts`.
- [Architecture](architecture.md) describes module boundaries, public/internal APIs, configuration lifecycle, and test tiers.
- [User extensibility](usercode.md) covers user-defined components, registers, logic, expressions, PID controllers, and the trust model.
- [Parameter bindings](parameter-bindings.md) explains formula-bound geometry fields, convection heat-transfer models, and solid property models.
- [Testing tiers](testing-slow.md) details fast, all-files, and opt-in slow scientific validation commands.
- [Solver convergence](solver-convergence.md) documents known convergence behavior, including coupled residual certification and dome-edge limit cycles.
- [Real-fluid performance](real-fluid-performance.md) discusses CoolProp backend rationale, derivative semantics, and performance guidance. Regenerated from live solves with `npx tsx scripts/real-fluid-performance.ts`.
- [Fluid catalogue](fluid-catalogue.md) describes the generated 124-fluid CoolProp HEOS catalogue, including picker contents, alias canonicalization, and no-transport validation semantics.
- [Solid properties](solid-properties-results.md) outlines the solid material catalogue (sources, temperature ranges, caveats) along with temperature-dependent property design and validation results.
- [Fluid-front transport](fluid-front-transport.md) details fluid-front transport model definition, lifecycle contracts, and verification.
- [Combustion](combustion.md) documents reacting junctions (CEA-coupled combustion chambers solved inside the core Newton system), the offline NASA CEA table generator, the LOX/RP-1 thruster validation case, and v1 limitations.
- [Compressible duct-flow validation](validation/compressible-report.md) recreates the NASA GFSSP TFAWS-2007 compressible-flow verification paper, case for case and figure for figure (Fanno, Rayleigh, combined friction and heat, converging–diverging nozzle). Regenerate with `npx tsx scripts/compressible-validation-report.ts`.
- [Incompressible hydraulics validation](validation/incompressible-hydraulics-report.md) verifies the steady solver against classical closed-form pipe hydraulics (Hagen–Poiseuille, Darcy–Weisbach, parallel splits, a Hardy-Cross multi-loop network, hydrostatics, pump operating point). Regenerate with `npx tsx scripts/hydraulics-validation-report.ts`.
- [Transient tank validation](validation/tank-transient-report.md) verifies the transient integrator against lumped tank gas dynamics (choked adiabatic blowdown, time-step convergence, two-tank equalization, adiabatic fill heating, scheduled-valve blowdown). Regenerate with `npx tsx scripts/tank-transient-validation-report.ts`.
- [Thermal network validation](validation/thermal-network-report.md) verifies the conjugate thermal system against closed-form heat transfer (composite wall, radiation–convection equilibrium, lumped-capacitance cooldown, heated pipe, counterflow heat exchanger vs ε–NTU). Regenerate with `npx tsx scripts/thermal-validation-report.ts`.
- [Combustion and rocket-thruster validation](validation/combustion-report.md) verifies the reacting-junction machinery against analytical solutions: CEA table thermodynamic identities and frozen c* closed forms, chamber/injector/choked-flow integral balances, isentropic and friction-inclusive quasi-1D nozzle profiles, and the regenerative wall stack against an exact series–parallel resistance network. Regenerate with `npx tsx scripts/combustion-validation-report.ts`.
- [Rigid-column fluid-transient validation](validation/fluid-transient-report.md) verifies the lumped fluid-inertia term and gas-cushion node against rigid-column surge theory (tanh startup, hyperbolic decay, gas-spring oscillator, polytropic compression). Regenerate with `npx tsx scripts/fluid-transient-validation-report.ts`.

See also [Contributing](../CONTRIBUTING.md) and [Security](../SECURITY.md).
