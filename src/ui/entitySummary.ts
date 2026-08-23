/**
 * entitySummary.ts — "what is this thing?" in a handful of rows.
 *
 * Pure: takes a config (plus an optional result) and an entity reference,
 * returns the few facts that identify the element — its type, endpoints, and
 * the two or three parameters that actually define it — followed by its
 * solved values when a run is on screen.
 *
 * Used by the outline's hover card. Deliberately NOT a second property
 * editor: it answers identification questions at a glance, and the property
 * panel remains the place to change anything.
 */
import type {
  NetworkConfig,
  Selection,
  SteadyResult,
  TransientResult,
} from "./types";
import type { EntityGlyphSpec } from "./components/EntityGlyph";
import type { UnitPreferences } from "./units";
import { formatWithUnit, formatSig } from "./format";
import { channelsForSelection } from "./selectionInspect";
import { resolveChannelAt } from "./channels";
import { formatChannelValue } from "./channelExplorer";
import { componentLabel, conductorLabel } from "./componentRegistry";
import { fluidSpecLabel } from "./fluidsUi";
import type { QuantityKind } from "./units";

export interface SummaryRow {
  label: string;
  value: string;
}

export interface EntitySummary {
  /** Element id (or a short stand-in for chrome rows). */
  title: string;
  /** Human type name: "Boundary node", "Pipe", "Convection tie". */
  subtitle: string;
  glyph?: EntityGlyphSpec;
  /** Defining parameters. */
  rows: SummaryRow[];
  /** Solved values from the displayed run, when there is one. */
  results: SummaryRow[];
}

export type SummarizableKind =
  "node" | "branch" | "solidNode" | "conductor" | "group" | "note";

/** Formula-bound fields carry `{ expr }`; show the expression verbatim. */
function scalarText(
  value: unknown,
  quantity: QuantityKind,
  prefs?: Partial<UnitPreferences>,
): string | null {
  if (typeof value === "number" && Number.isFinite(value))
    return formatWithUnit(value, quantity, prefs);
  if (
    value !== null &&
    typeof value === "object" &&
    "expr" in (value as Record<string, unknown>)
  ) {
    return `= ${String((value as { expr: unknown }).expr)}`;
  }
  return null;
}

function push(
  rows: SummaryRow[],
  label: string,
  value: unknown,
  quantity: QuantityKind,
  prefs?: Partial<UnitPreferences>,
): void {
  const text = scalarText(value, quantity, prefs);
  if (text !== null) rows.push({ label, value: text });
}

function pushPlain(
  rows: SummaryRow[],
  label: string,
  value: unknown,
  suffix = "",
): void {
  if (typeof value === "number" && Number.isFinite(value))
    rows.push({ label, value: `${formatSig(value)}${suffix}` });
  else if (typeof value === "string" && value.length > 0)
    rows.push({ label, value });
}

/** The two or three parameters that define each component type. */
function branchParameterRows(
  component: Record<string, unknown>,
  prefs?: Partial<UnitPreferences>,
): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const type = String(component.type);
  switch (type) {
    case "pipe":
    case "heatedPipe":
      push(rows, "Length", component.length, "length", prefs);
      push(rows, "Diameter", component.diameter, "length", prefs);
      push(rows, "Roughness", component.roughness, "length", prefs);
      if (type === "heatedPipe") {
        push(rows, "UA", component.ua, "power", prefs);
        push(rows, "Wall T", component.wallTemperature, "temperature", prefs);
      }
      break;
    case "orifice":
      push(rows, "Area", component.area, "area", prefs);
      pushPlain(rows, "Cd", component.cd);
      break;
    case "cavitatingVenturi":
      push(rows, "Throat area", component.throatArea, "area", prefs);
      pushPlain(rows, "Cd", component.cd);
      break;
    case "valve":
      push(rows, "Area", component.area, "area", prefs);
      pushPlain(rows, "Cd", component.cd);
      pushPlain(rows, "Position", component.position);
      break;
    case "checkValve":
    case "dynamicCheckValve":
      push(rows, "Area", component.area, "area", prefs);
      pushPlain(rows, "Cd", component.cd);
      break;
    case "reliefValve":
      push(rows, "Crack", component.crackPressure, "pressure", prefs);
      push(rows, "Full open", component.fullOpenPressure, "pressure", prefs);
      push(rows, "Area", component.area, "area", prefs);
      break;
    case "resistance":
    case "customResistance":
      pushPlain(rows, "K", component.k);
      push(rows, "Area", component.area, "area", prefs);
      break;
    case "pump":
      if (Array.isArray(component.curve))
        rows.push({
          label: "Curve",
          value: `${component.curve.length} points`,
        });
      break;
    case "bend":
      push(rows, "Diameter", component.diameter, "length", prefs);
      pushPlain(rows, "Angle", component.angle, "°");
      pushPlain(rows, "r/D", component.rOverD);
      break;
    case "areaChange":
      push(rows, "Area in", component.areaIn, "area", prefs);
      push(rows, "Area out", component.areaOut, "area", prefs);
      break;
    case "flowSource":
      push(rows, "Mass flow", component.massFlow, "massFlow", prefs);
      break;
    case "regulator":
      push(rows, "Set pressure", component.setPressure, "pressure", prefs);
      push(rows, "Max CdA", component.maxCdA, "area", prefs);
      break;
    case "dpTable":
      if (Array.isArray(component.table))
        rows.push({
          label: "Table",
          value: `${component.table.length} points`,
        });
      break;
    case "userComponent":
      pushPlain(rows, "Component", component.component);
      break;
  }
  return rows;
}

function conductorParameterRows(
  type: Record<string, unknown>,
  prefs?: Partial<UnitPreferences>,
): SummaryRow[] {
  const rows: SummaryRow[] = [];
  switch (String(type.kind)) {
    case "conduction":
      pushPlain(rows, "k", type.k);
      push(rows, "Area", type.area, "area", prefs);
      push(rows, "Length", type.length, "length", prefs);
      break;
    case "convection":
      if (
        type.correlation !== undefined &&
        typeof type.correlation === "object" &&
        type.correlation !== null
      ) {
        const model = (type.correlation as { model?: unknown }).model;
        rows.push({ label: "Model", value: String(model ?? "correlation") });
      } else {
        pushPlain(rows, "h", type.h);
      }
      push(rows, "Area", type.area, "area", prefs);
      break;
    case "radiation":
      pushPlain(rows, "Emissivity", type.emissivity);
      push(rows, "Area", type.area, "area", prefs);
      pushPlain(rows, "View factor", type.viewFactor);
      break;
  }
  return rows;
}

/** Solved values for the element, from the displayed run. */
function resultRows(
  config: NetworkConfig,
  result: SteadyResult | TransientResult | null | undefined,
  kind: SummarizableKind,
  id: string,
  timeIndex: number | null,
  prefs?: Partial<UnitPreferences>,
): SummaryRow[] {
  if (!result) return [];
  if (
    kind !== "node" &&
    kind !== "branch" &&
    kind !== "solidNode" &&
    kind !== "conductor"
  )
    return [];
  const descriptors = channelsForSelection(config, result, {
    kind,
    id,
  } as Selection);
  const rows: SummaryRow[] = [];
  for (const d of descriptors) {
    // listChannels already restricted this to channels the result carries;
    // a null here just means the field is absent for this element.
    const value = resolveChannelAt(result, d.channel, timeIndex);
    if (value === null) continue;
    // `label` is "<element> · <field>"; the card already names the element.
    const field = d.label.includes(" · ")
      ? d.label.slice(d.label.indexOf(" · ") + 3)
      : d.label;
    rows.push({ label: field, value: formatChannelValue(value, d, prefs) });
    if (rows.length >= 6) break;
  }
  return rows;
}

export function summarizeEntity(args: {
  /** Live config — the parameters shown are the ones you are editing. */
  config: NetworkConfig;
  result?: SteadyResult | TransientResult | null;
  /** Config the displayed result was solved against, when it differs. */
  resultConfig?: NetworkConfig | null;
  timeIndex?: number | null;
  unitPreferences?: Partial<UnitPreferences>;
  kind: SummarizableKind;
  id: string;
}): EntitySummary | null {
  const { config, result, kind, id } = args;
  const prefs = args.unitPreferences;
  const timeIndex = args.timeIndex ?? null;
  const results = resultRows(
    args.resultConfig ?? config,
    result,
    kind,
    id,
    timeIndex,
    prefs,
  );

  if (kind === "node") {
    const node = config.nodes.find((n) => n.id === id);
    if (!node) return null;
    const rows: SummaryRow[] = [];
    if (node.label && node.label !== node.id)
      rows.push({ label: "Label", value: node.label });
    rows.push({
      label: "Fluid",
      value: node.fluid ?? fluidSpecLabel(config.fluid),
    });
    push(rows, "Pressure", node.pressure, "pressure", prefs);
    if (node.quality !== undefined) pushPlain(rows, "Quality", node.quality);
    else push(rows, "Temperature", node.temperature, "temperature", prefs);
    push(rows, "Volume", node.volume, "volume", prefs);
    push(rows, "Heat input", node.heatInput, "power", prefs);
    if (node.pressureSchedule || node.temperatureSchedule)
      rows.push({ label: "Schedules", value: "yes" });
    if (node.group) rows.push({ label: "Subnetwork", value: node.group });
    return {
      title: node.id,
      subtitle: node.type === "boundary" ? "Boundary node" : "Internal node",
      glyph: { entity: "node", type: node.type },
      rows,
      results,
    };
  }

  if (kind === "branch") {
    const branch = config.branches.find((b) => b.id === id);
    if (!branch) return null;
    const rows: SummaryRow[] = [];
    if (branch.label && branch.label !== branch.id)
      rows.push({ label: "Label", value: branch.label });
    rows.push({ label: "From → to", value: `${branch.from} → ${branch.to}` });
    rows.push(
      ...branchParameterRows(
        branch.component as unknown as Record<string, unknown>,
        prefs,
      ),
    );
    return {
      title: branch.id,
      subtitle: componentLabel(branch.component.type),
      glyph: { entity: "branch", component: branch.component.type },
      rows,
      results,
    };
  }

  if (kind === "solidNode") {
    const node = (config.solidNodes ?? []).find((n) => n.id === id);
    if (!node) return null;
    const rows: SummaryRow[] = [];
    if (node.label && node.label !== node.id)
      rows.push({ label: "Label", value: node.label });
    push(rows, "Temperature", node.temperature, "temperature", prefs);
    pushPlain(rows, "Mass", node.mass, " kg");
    if (typeof node.cp === "number") pushPlain(rows, "cp", node.cp, " J/kg·K");
    else if (node.cp) rows.push({ label: "cp", value: "table / material" });
    push(rows, "Heat input", node.heatInput, "power", prefs);
    return {
      title: node.id,
      subtitle: node.type === "ambient" ? "Ambient node" : "Solid node",
      glyph: { entity: "solidNode", type: node.type },
      rows,
      results,
    };
  }

  if (kind === "conductor") {
    const conductor = (config.conductors ?? []).find((c) => c.id === id);
    if (!conductor) return null;
    const rows: SummaryRow[] = [];
    if (conductor.label && conductor.label !== conductor.id)
      rows.push({ label: "Label", value: conductor.label });
    rows.push({
      label: "Between",
      value: `${conductor.from} ↔ ${conductor.to}`,
    });
    rows.push(
      ...conductorParameterRows(
        conductor.type as unknown as Record<string, unknown>,
        prefs,
      ),
    );
    return {
      title: conductor.id,
      subtitle: `${conductorLabel(conductor.type.kind)} tie`,
      glyph: { entity: "conductor", kind: conductor.type.kind },
      rows,
      results,
    };
  }

  if (kind === "group") {
    const group = (config.groups ?? []).find((g) => g.id === id);
    if (!group) return null;
    const members = config.nodes.filter((n) => n.group === group.id).length;
    return {
      title: group.label || group.id,
      subtitle: "Subnetwork",
      glyph: { entity: "group" },
      rows: [{ label: "Members", value: `${members} nodes` }],
      results: [],
    };
  }

  const note = (config.notes ?? []).find((n) => n.id === id);
  if (!note) return null;
  return {
    title: note.id,
    subtitle: "Note",
    glyph: { entity: "note" },
    rows: [
      {
        label: "Text",
        value:
          note.text.length > 160 ? `${note.text.slice(0, 160)}…` : note.text,
      },
    ],
    results: [],
  };
}
