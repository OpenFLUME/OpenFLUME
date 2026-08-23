/**
 * Global-settings section inventory, shared by every host of the settings UI
 * (the modal dialog and any shell page/stage that mounts SettingsSections).
 * The active section lives in the store so it survives a re-render and is
 * addressable from tests and tooling.
 */
import type { SettingsTabId } from "./store";

export const SETTINGS_TABS: {
  id: SettingsTabId;
  label: string;
  title: string;
}[] = [
  { id: "solver", label: "Solver", title: "Mode, convergence, time stepping" },
  {
    id: "physics",
    label: "Physics",
    title: "Compressible formulation and closure calibration",
  },
  { id: "fluids", label: "Fluids", title: "Default fluid and named continua" },
  {
    id: "species",
    label: "Species",
    title: "Multi-species transport and reactions",
  },
  { id: "units", label: "Units", title: "Display units and presets" },
  {
    id: "extensibility",
    label: "Extensibility",
    title: "Registers, logic rules, and controllers",
  },
];
