/**
 * Problem-type templates for the New-model flow.
 *
 * Each template seeds a runnable starting point for a class of problem —
 * fluid choice, solver mode + numerics, physics flags, and a small starter
 * topology — so the user begins from "adjust the numbers", not from a blank
 * canvas and default settings that may be wrong for the problem class.
 *
 * Deterministic by design: templates are built from the bundled examples
 * (already validated and solver-tuned), cloned and renamed.  The `seeds`
 * strings surface WHAT the template configures so the choice is
 * transparent, mirroring how the settings advisor always shows a rationale.
 */
import type { NetworkConfig } from "./types";
import { cloneConfig } from "./utils";
import { examples } from "./examples";

export interface ProblemTemplate {
  id: string;
  label: string;
  /** One-line problem description shown under the label. */
  description: string;
  /** What the template pre-configures (fluid, mode, physics, numerics). */
  seeds: string[];
  /** Bundled example the starter model is cloned from. */
  exampleName: string;
}

export const PROBLEM_TEMPLATES: ProblemTemplate[] = [
  {
    id: "liquid-network",
    label: "Liquid distribution network",
    description:
      "Steady flow splits and pressure drops through a piping network.",
    seeds: ["Water (incompressible)", "Steady solve", "Pipe/junction starter"],
    exampleName: "Water distribution network",
  },
  {
    id: "gas-blowdown",
    label: "Gas blowdown",
    description: "A pressurized volume vents through an orifice over time.",
    seeds: [
      "Ideal gas",
      "Transient solve with tuned dt/end time",
      "Orifice (Y-factor, choking included)",
    ],
    exampleName: "Tank blowdown",
  },
  {
    id: "conjugate-ht",
    label: "Heated pipe with wall (conjugate HT)",
    description:
      "Fluid stream coupled to a solid wall with convection and radiation.",
    seeds: [
      "Solid wall nodes + conductors",
      "Convection correlation preselected",
      "Steady solve",
    ],
    exampleName: "Heated pipe with radiating wall (conjugate HT)",
  },
  {
    id: "heat-exchanger",
    label: "Counterflow heat exchanger",
    description: "Two streams exchanging heat through a separating wall.",
    seeds: [
      "Two named fluid continua",
      "Wall conductors between streams",
      "Steady solve",
    ],
    exampleName: "Water-water counterflow heat exchanger",
  },
  {
    id: "cryo-chilldown",
    label: "Cryogenic line chilldown",
    description:
      "Cryogen quenching a warm line — two-phase transients and wall cooldown.",
    seeds: [
      "Real fluid (CoolProp nitrogen)",
      "Transient solve, adaptive-friendly numerics",
      "Wall thermal mass + boiling-aware convection",
    ],
    exampleName: "Cryogenic line cooldown",
  },
  {
    id: "thruster-feed",
    label: "Thruster feed and combustor",
    description:
      "Propellant feed lines into a reacting junction with a nozzle.",
    seeds: [
      "LOX/RP-1 real fluids",
      "Reacting junction (CEA products)",
      "Steady solve with momentum flux + kinetic energy",
    ],
    exampleName: "LOX/RP-1 thruster (combustor)",
  },
];

/** Build the starter NetworkConfig for a template (fresh deep clone). */
export function buildTemplateConfig(template: ProblemTemplate): NetworkConfig {
  const example = examples[template.exampleName];
  if (!example) {
    throw new Error(
      `Problem template "${template.id}" references unknown example "${template.exampleName}"`,
    );
  }
  const cfg = cloneConfig(example);
  cfg.meta = { ...cfg.meta, name: template.label };
  return cfg;
}
