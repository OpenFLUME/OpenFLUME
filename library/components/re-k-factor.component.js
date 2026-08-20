/*
 * Reynolds-dependent K-factor resistance (user-component example)
 *
 * A resistance whose loss coefficient K varies with the Reynolds number,
 * computed from the flow conditions.  This is the user-code equivalent of
 * the built-in customResistance with a kTable, but shows how to perform
 * table interpolation in plain JavaScript.
 *
 * Physics
 *   Re = rho * |v| * D / mu,   v = mdot / (rho * area)
 *   K  = piecewise-linear interpolation from the embedded K(Re) table
 *   dP = K * mdot * |mdot| / (2 * rho * area^2)
 *
 * Parameters
 *   diameter — hydraulic diameter for Re calculation [m]  (default 0.02)
 *   area     — flow area [m^2]                            (default 3.14e-4)
 *
 * The K(Re) table below is a generic turbulent-transition curve:
 *   Re < 2300  : K ~ 50 (laminar, large losses)
 *   Re ~ 4000  : K ~ 5  (transition)
 *   Re > 10000 : K ~ 1.2 (turbulent, lower losses)
 *
 * Pure function: no module-scope mutable state, no Date/Math.random.
 */
/* global defineComponent */
defineComponent({
  metadata: {
    name: "re-k-factor",
    label: "Re-dependent K-factor",
    description:
      "Resistance with Reynolds-dependent loss coefficient. " +
      "Demonstrates table interpolation in user code.",
    version: "1.0.0",
    params: [
      {
        name: "diameter",
        label: "Hydraulic diameter",
        unit: "m",
        default: 0.02,
        min: 1e-6,
      },
      {
        name: "area",
        label: "Flow area",
        unit: "m^2",
        default: 3.14e-4,
        min: 1e-12,
      },
    ],
  },
  pressureDrop({ mdot, rho, mu, area, params }) {
    const A = Math.max(area ?? params.area, 1e-12);
    const D = Math.max(params.diameter, 1e-12);

    // Velocity and Reynolds number.
    const v = mdot / (rho * A);
    const Re = (rho * Math.abs(v) * D) / Math.max(mu, 1e-30);

    // K(Re) table — [Re, K] pairs, monotonically increasing in Re.
    const table = [
      [0, 50],
      [100, 50],
      [1000, 5],
      [4000, 3],
      [10000, 1.5],
      [100000, 1.2],
      [1e6, 1.0],
    ];

    // Piecewise-linear interpolation with clamping.
    let K;
    if (Re <= table[0][0]) {
      K = table[0][1];
    } else if (Re >= table[table.length - 1][0]) {
      K = table[table.length - 1][1];
    } else {
      K = table[0][1]; // fallback
      for (let i = 1; i < table.length; i++) {
        if (Re <= table[i][0]) {
          const [Re0, K0] = table[i - 1];
          const [Re1, K1] = table[i];
          const t = (Re - Re0) / (Re1 - Re0);
          K = K0 + t * (K1 - K0);
          break;
        }
      }
    }

    // Sign-preserving quadratic pressure drop.
    return (K * mdot * Math.abs(mdot)) / (2 * rho * A * A);
  },
});
