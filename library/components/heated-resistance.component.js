/*
 * Heated resistance (user-component example)
 *
 * A K-factor hydraulic resistance with an additional heat(args) callback
 * that models convective heat transfer from a constant-temperature wall
 * to the fluid stream using the epsilon-NTU method.
 *
 * This is the user-code equivalent of the built-in HeatedPipe's thermal
 * model, paired with a simple resistance hydraulic model.
 *
 * Hydraulics
 *   dP = K * mdot * |mdot| / (2 * rho * area^2)
 *
 * Heat (epsilon-NTU)
 *   Q = (1 - exp(-UA / (mdot * cp))) * mdot * cp * (T_wall - T_up)
 *   Q > 0 heats the fluid (wall hotter than stream); Q < 0 cools it.
 *   As mdot → 0, Q → 0 gracefully.
 *
 * Parameters
 *   K        — loss coefficient                         (default 2)
 *   area     — flow area [m^2]                           (default 1e-4)
 *   ua       — overall heat transfer coeff × area [W/K]  (default 10)
 *   wallTemp — wall temperature [K]                      (default 350)
 *
 * The heat(args) callback receives:
 *   mdot, Tup (upstream temperature, K), cp (specific heat, J/(kg·K)),
 *   P, h, area, params, fluid
 *
 * Pure function: no module-scope mutable state, no Date/Math.random.
 */
/* global defineComponent */
defineComponent({
  metadata: {
    name: "heated-resistance",
    label: "Heated resistance",
    description:
      "K-factor resistance with epsilon-NTU wall heat transfer. " +
      "Demonstrates the heat(args) callback for thermal coupling.",
    version: "1.0.0",
    params: [
      { name: "K", label: "Loss coefficient", unit: "1", default: 2, min: 0 },
      {
        name: "area",
        label: "Flow area",
        unit: "m^2",
        default: 1e-4,
        min: 1e-12,
      },
      {
        name: "ua",
        label: "UA (heat transfer)",
        unit: "W/K",
        default: 10,
        min: 0,
      },
      {
        name: "wallTemp",
        label: "Wall temperature",
        unit: "K",
        default: 350,
        min: 0,
      },
    ],
  },
  pressureDrop({ mdot, rho, area, params }) {
    const A = Math.max(area ?? params.area, 1e-12);
    return (params.K * mdot * Math.abs(mdot)) / (2 * rho * A * A);
  },
  heat({ mdot, Tup, cp, params }) {
    const mcp = Math.max(Math.abs(mdot) * cp, 1e-9);
    const effectiveness = 1 - Math.exp(-params.ua / mcp);
    return effectiveness * mcp * (params.wallTemp - Tup);
  },
});
