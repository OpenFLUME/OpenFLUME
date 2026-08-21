/**
 * componentRegistry.ts — single source of truth for every branch component
 * type and conductor kind the UI knows about.
 *
 * Connection choices, the PropertyPanel type dropdown, canvas edge symbols and
 * new-element default params ALL read from here, so a component that exists
 * in the solver/schema can never silently go missing from the UI (the
 * `cavitatingVenturi` orphan bug).
 *
 * Visual rendering is handled by `PidSymbol.tsx` (inline SVG in the
 * conventional process-schematic/P&ID visual vocabulary). `symbol` below
 * keys into it. `glyph` is a terse text-only fallback kept for non-SVG
 * contexts (e.g. plain-text export/log lines) — never the primary visual.
 */
import type { NetworkConfig } from "./types";

type BranchComponent = NetworkConfig["branches"][number]["component"];
type ConductorType = NonNullable<NetworkConfig["conductors"]>[number]["type"];

export type ComponentCategory = "common" | "advanced" | "custom";

export interface BranchComponentDef {
  id: BranchComponent["type"];
  label: string;
  /** PidSymbol kind (defaults to `id` when omitted). */
  symbol?: string;
  category: ComponentCategory;
  /** Factory for a fresh component with sane defaults. */
  defaults: () => BranchComponent;
}

export interface ConductorDef {
  id: ConductorType["kind"];
  label: string;
  symbol?: string;
  defaults: () => ConductorType;
}

export const BRANCH_COMPONENTS: BranchComponentDef[] = [
  {
    id: "pipe",
    label: "Pipe",
    category: "common",
    defaults: () => ({
      type: "pipe",
      length: 1,
      diameter: 0.02,
      roughness: 1e-5,
    }),
  },
  {
    id: "valve",
    label: "Valve",
    category: "common",
    defaults: () => ({ type: "valve", area: 0.001, cd: 0.6, position: 1 }),
  },
  {
    id: "orifice",
    label: "Orifice",
    category: "common",
    defaults: () => ({ type: "orifice", area: 0.001, cd: 0.6 }),
  },
  {
    id: "pump",
    label: "Pump",
    category: "common",
    defaults: () => ({
      type: "pump",
      curve: [
        [0, 0],
        [0.001, 100000],
      ],
    }),
  },
  {
    id: "checkValve",
    label: "Check Valve",
    category: "common",
    defaults: () => ({ type: "checkValve", area: 0.001, cd: 0.6 }),
  },
  {
    id: "reliefValve",
    label: "Relief Valve",
    category: "common",
    defaults: () => ({
      type: "reliefValve",
      crackPressure: 150000,
      fullOpenPressure: 200000,
      area: 0.001,
      cd: 0.6,
    }),
  },
  {
    id: "dynamicCheckValve",
    label: "Dynamic Check Valve",
    category: "advanced",
    defaults: () => ({
      type: "dynamicCheckValve",
      area: 0.001,
      cd: 0.6,
      mass: 0.05,
      springRate: 5000,
      preload: 50,
      damping: 5,
      stroke: 0.005,
      initialPosition: 0,
    }),
  },
  {
    id: "flowSource",
    label: "Flow Source",
    category: "common",
    defaults: () => ({ type: "flowSource", massFlow: 0.1 }),
  },
  {
    id: "orificeCompressible",
    label: "Comp Orifice",
    category: "advanced",
    defaults: () => ({ type: "orificeCompressible", area: 0.001, cd: 0.6 }),
  },
  {
    id: "cavitatingVenturi",
    label: "Cavitating Venturi",
    category: "advanced",
    defaults: () => ({
      type: "cavitatingVenturi",
      throatArea: 5e-6,
      cd: 0.84,
      recoveryFactor: 0.5,
    }),
  },
  {
    id: "resistance",
    label: "Resistance",
    category: "advanced",
    defaults: () => ({ type: "resistance", k: 1, area: 0.001 }),
  },
  {
    id: "bend",
    label: "Bend",
    category: "advanced",
    defaults: () => ({
      type: "bend",
      diameter: 0.02,
      angle: 90,
      rOverD: 1.5,
      roughness: 1e-5,
    }),
  },
  {
    id: "areaChange",
    label: "Area Change",
    category: "advanced",
    defaults: () => ({ type: "areaChange", areaIn: 0.001, areaOut: 0.002 }),
  },
  {
    id: "regulator",
    label: "Regulator",
    category: "advanced",
    defaults: () => ({ type: "regulator", setPressure: 150000, maxCdA: 0.001 }),
  },
  {
    id: "heatedPipe",
    label: "Heated Pipe",
    category: "advanced",
    defaults: () => ({
      type: "heatedPipe",
      length: 1,
      diameter: 0.02,
      roughness: 1e-5,
      elevationChange: 0,
      ua: 10,
      wallTemperature: 350,
    }),
  },
  {
    id: "dpTable",
    label: "Pressure Drop Table",
    category: "custom",
    defaults: () => ({
      type: "dpTable",
      points: [
        [0, 0],
        [1, 1000],
      ],
      extrapolate: "clamp",
    }),
  },
  {
    id: "customResistance",
    label: "Custom Resistance",
    category: "custom",
    defaults: () => ({ type: "customResistance", k: 1, area: 0.001 }),
  },
  {
    id: "userComponent",
    label: "Local Component",
    category: "custom",
    defaults: () => ({
      type: "userComponent",
      component: "",
      params: {},
      area: 0.001,
    }),
  },
];

export const CONDUCTORS: ConductorDef[] = [
  {
    id: "conduction",
    label: "Conduction",
    defaults: () => ({ kind: "conduction", k: 1, area: 0.01, length: 0.1 }),
  },
  {
    id: "convection",
    label: "Convection",
    defaults: () => ({ kind: "convection", h: 100, area: 0.01 }),
  },
  {
    id: "radiation",
    label: "Radiation",
    defaults: () => ({
      kind: "radiation",
      emissivity: 0.8,
      area: 0.01,
      viewFactor: 1,
    }),
  },
];

const BRANCH_MAP = new Map(BRANCH_COMPONENTS.map((c) => [c.id, c]));
const CONDUCTOR_MAP = new Map(CONDUCTORS.map((c) => [c.id, c]));

export function componentDef(type: string): BranchComponentDef | undefined {
  return BRANCH_MAP.get(type as BranchComponent["type"]);
}

export function componentLabel(type: string): string {
  return componentDef(type)?.label ?? type;
}

/** PidSymbol kind for a branch component type. */
export function componentSymbol(type: string): string {
  const def = componentDef(type);
  return def?.symbol ?? def?.id ?? type;
}

export function conductorDef(kind: string): ConductorDef | undefined {
  return CONDUCTOR_MAP.get(kind as ConductorType["kind"]);
}

export function conductorLabel(kind: string): string {
  return conductorDef(kind)?.label ?? kind;
}

/** PidSymbol kind for a conductor kind. */
export function conductorSymbol(kind: string): string {
  const def = conductorDef(kind);
  return def?.symbol ?? def?.id ?? kind;
}

/** Fresh default component for a known type. */
export function defaultComponent(type: string): BranchComponent {
  const definition = componentDef(type);
  if (!definition) throw new Error(`Unknown branch component type: ${type}`);
  return definition.defaults();
}

export function defaultConductor(kind: string): ConductorType {
  const definition = conductorDef(kind);
  if (!definition) throw new Error(`Unknown conductor kind: ${kind}`);
  return definition.defaults();
}

/**
 * Defaults for `type` with compatible params carried over from `current`:
 * a key present in both with a matching JS type (arrays match arrays) keeps
 * the current value. Switching pipe → heatedPipe keeps length/diameter/
 * roughness; switching orifice → valve keeps area/cd; etc.
 */
export function migrateComponent(
  type: string,
  current: BranchComponent,
): BranchComponent {
  const next = defaultComponent(type) as Record<string, unknown>;
  const cur = current as unknown as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (key === "type") continue;
    const curVal = cur[key];
    if (curVal === undefined) continue;
    const nextVal = next[key];
    if (Array.isArray(nextVal) && Array.isArray(curVal)) {
      next[key] = curVal;
    } else if (typeof nextVal === typeof curVal) {
      next[key] = curVal;
    }
  }
  return next as unknown as BranchComponent;
}
