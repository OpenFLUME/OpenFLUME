/*
 * Dome-loaded pressure regulator (user-component example)
 *
 * A dome-loaded regulator uses gas pressure in a dome chamber (rather than a
 * spring) to set the outlet pressure.  The dome pressure P_dome acts as the
 * setpoint: when downstream pressure P_to is below P_dome the valve opens,
 * when it exceeds P_dome the valve closes.
 *
 * This component models the proportional opening behaviour as a pure
 * pressureDrop law:
 *
 *   opening  = clamp((P_dome - P_to) / band, 0, 1)   [tanh-smoothed]
 *   CdA_eff  = CdA_max * opening
 *   dP       = mdot * |mdot| / (2 * rho * CdA_eff^2)
 *
 * Parameters
 *   P_dome   — dome / setpoint pressure [Pa]           (default 200 000)
 *   CdA_max  — fully-open effective flow coefficient × area [m^2]  (default 1e-4)
 *   band     — proportional band [Pa]                   (default 50 000)
 *              (valve modulates fully across this range below P_dome)
 *   eps      — near-zero-flow smoothing [Pa]            (default 1 000)
 *
 * Notes
 *   • This is a *proportional* model, not an exact setpoint holder.
 *     For exact downstream pressure control use the built-in Regulator
 *     component, which the solver handles via a residual constraint.
 *   • The dome pressure can be varied per-instance to model different
 *     setpoints, or swept to study regulator response curves.
 *   • args.pTo is used as the sensed downstream pressure.  When pTo is
 *     undefined (e.g. certain solver modes), the valve defaults to fully
 *     open so the network remains solvable.
 *   • Pure function: no module-scope state, no Date/Math.random.
 */
/* global defineComponent */
defineComponent({
  metadata: {
    name: "dome-regulator",
    label: "Dome-loaded regulator",
    description:
      "Proportional-opening pressure regulator with dome-pressure setpoint. " +
      "Models valve opening as a function of downstream pressure error.",
    version: "1.0.0",
    params: [
      {
        name: "P_dome",
        label: "Dome pressure",
        unit: "Pa",
        default: 200000,
        min: 0,
      },
      {
        name: "CdA_max",
        label: "Max CdA (fully open)",
        unit: "m^2",
        default: 1e-4,
        min: 0,
      },
      {
        name: "band",
        label: "Proportional band",
        unit: "Pa",
        default: 50000,
        min: 1,
      },
      { name: "eps", label: "Smoothing", unit: "Pa", default: 1000, min: 1 },
    ],
  },
  pressureDrop({ mdot, rho, pTo, params }) {
    // Valve opening fraction: 1 when P_to << P_dome, 0 when P_to >= P_dome.
    // tanh smoothing replaces the hard clamp for solver differentiability.
    // When pTo is unavailable the valve defaults to fully open.
    const opening =
      typeof pTo === "number" && Number.isFinite(pTo)
        ? 0.5 * (1 + Math.tanh((params.P_dome - pTo) / params.band))
        : 1;

    // Effective CdA with floor to avoid singularity when closed.
    const CdA = Math.max(params.CdA_max * opening, 1e-12);

    // Sign-preserving quadratic pressure drop.  The linear eps term
    // dominates near mdot = 0, keeping the FD Jacobian finite there.
    return (params.eps * mdot + mdot * Math.abs(mdot)) / (2 * rho * CdA * CdA);
  },
});
