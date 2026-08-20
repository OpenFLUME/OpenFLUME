/**
 * Example local component: generic K-factor resistance.
 *
 * Files are self-contained scripts. The app injects defineComponent; do not
 * import or export anything here.
 */

/* global defineComponent */
defineComponent({
  metadata: {
    // This name is the componentLibrary key referenced by userComponent branches.
    name: "example-resistance",
    label: "Example Resistance (K-factor)",
    description: "Generic incompressible K-factor resistance.",
    version: "1.0.0",
    params: [
      { name: "K", label: "Loss coefficient K", unit: "1", default: 2, min: 0 },
    ],
  },

  /** Return pressure drop from the branch "from" node to its "to" node [Pa]. */
  pressureDrop({ mdot, rho, area, params }) {
    const flowArea = Math.max(area ?? 1e-4, 1e-12);
    return (params.K * mdot * Math.abs(mdot)) / (2 * rho * flowArea * flowArea);
  },
});
