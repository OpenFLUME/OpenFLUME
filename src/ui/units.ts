export type QuantityKind =
  | "pressure"
  | "temperature"
  | "length"
  | "area"
  | "volume"
  | "massFlow"
  | "massFlux"
  | "volumetricFlow"
  | "density"
  | "velocity"
  | "power"
  | "heatFlux"
  | "thermalConductivity"
  | "heatTransferCoeff"
  | "specificHeat"
  | "specificEnergy"
  | "specificEntropy"
  | "viscosity"
  | "time"
  | "angle"
  | "dimensionless";

export type UnitId = string;

export interface UnitDef {
  id: UnitId;
  symbol: string;
  toSI: (v: number) => number;
  fromSI: (v: number) => number;
}

const K: UnitDef = { id: "K", symbol: "K", toSI: (v) => v, fromSI: (v) => v };
const C: UnitDef = {
  id: "C",
  symbol: "°C",
  toSI: (v) => v + 273.15,
  fromSI: (v) => v - 273.15,
};
const F: UnitDef = {
  id: "F",
  symbol: "°F",
  toSI: (v) => ((v + 459.67) * 5) / 9,
  fromSI: (v) => (v * 9) / 5 - 459.67,
};
const R: UnitDef = {
  id: "R",
  symbol: "°R",
  toSI: (v) => (v * 5) / 9,
  fromSI: (v) => (v * 9) / 5,
};

function linear(factor: number, symbol: string): UnitDef {
  return {
    id: symbol,
    symbol,
    toSI: (v) => v * factor,
    fromSI: (v) => v / factor,
  };
}

export const UNITS: Record<QuantityKind, UnitDef[]> = {
  pressure: [
    linear(1, "Pa"),
    linear(1e3, "kPa"),
    linear(1e6, "MPa"),
    linear(1e5, "bar"),
    linear(101325, "atm"),
    linear(6894.757293168, "psi"),
  ],
  temperature: [K, C, F, R],
  length: [
    linear(1, "m"),
    linear(1e-3, "mm"),
    linear(1e-2, "cm"),
    linear(0.0254, "in"),
    linear(0.3048, "ft"),
  ],
  area: [
    linear(1, "m²"),
    linear(1e-4, "cm²"),
    linear(1e-6, "mm²"),
    linear(0.0254 * 0.0254, "in²"),
  ],
  volume: [
    linear(1, "m³"),
    linear(1e-3, "L"),
    linear(Math.pow(0.0254, 3), "in³"),
    linear(Math.pow(0.3048, 3), "ft³"),
    linear(3.785411784e-3, "gal(US)"),
  ],
  massFlow: [
    linear(1, "kg/s"),
    linear(1e-3, "g/s"),
    linear(1 / 3600, "kg/h"),
    linear(0.45359237, "lbm/s"),
    linear(0.45359237 / 3600, "lbm/h"),
  ],
  // Mass flux G = ṁ/A.  1 lbm/(ft²·s) = 0.45359237 / 0.3048² kg/(m²·s).
  massFlux: [
    linear(1, "kg/(m²·s)"),
    linear(0.45359237 / (0.3048 * 0.3048), "lbm/(ft²·s)"),
  ],
  volumetricFlow: [
    linear(1, "m³/s"),
    linear(1e-3 / 60, "L/min"),
    linear(3.785411784e-3 / 60, "gpm(US)"),
    linear(Math.pow(0.3048, 3), "ft³/s"),
  ],
  density: [
    linear(1, "kg/m³"),
    linear(1000, "g/cm³"),
    linear(16.018463374, "lbm/ft³"),
  ],
  velocity: [linear(1, "m/s"), linear(0.3048, "ft/s")],
  power: [linear(1, "W"), linear(1000, "kW"), linear(1055.05585262, "BTU/s")],
  // Heat flux q″ = Q/A.  1 BTU_IT/(hr·ft²) = (1055.05585262/3600) / 0.3048² W/m².
  heatFlux: [
    linear(1, "W/m²"),
    linear(1000, "kW/m²"),
    linear(1055.05585262 / 3600 / (0.3048 * 0.3048), "BTU/(hr·ft²)"),
  ],
  thermalConductivity: [
    linear(1, "W/(m·K)"),
    linear(1.730734666, "BTU/(hr·ft·°F)"),
  ],
  heatTransferCoeff: [
    linear(1, "W/(m²·K)"),
    linear(5.678263337, "BTU/(hr·ft²·°F)"),
  ],
  // Specific heat capacity.  Only exact, well-defined conversions: pure SI
  // prefixes plus the IT-BTU family already used for power/thermalConductivity
  // (1 BTU_IT/(lbm·°F) = 1055.05585262 / 0.45359237 × 9/5 = 4186.8 J/(kg·K)).
  specificHeat: [
    linear(1, "J/(kg·K)"),
    linear(1000, "kJ/(kg·K)"),
    linear(4186.8, "BTU/(lbm·°F)"),
  ],
  // Specific energy (enthalpy, internal energy).  1 BTU_IT/lbm =
  // 1055.05585262 / 0.45359237 = 2326 J/kg exactly.
  specificEnergy: [
    linear(1, "J/kg"),
    linear(1000, "kJ/kg"),
    linear(1e6, "MJ/kg"),
    linear(2326, "BTU/lbm"),
  ],
  // Specific entropy.  Dimensionally identical to specificHeat but kept
  // separate so labels and unit preferences can differ; the US customary
  // unit is per degree Rankine (1 BTU_IT/(lbm·°R) = 2326 × 9/5 J/(kg·K)).
  specificEntropy: [
    linear(1, "J/(kg·K)"),
    linear(1000, "kJ/(kg·K)"),
    linear(4186.8, "BTU/(lbm·°R)"),
  ],
  // Dynamic viscosity.  1 lbm/(ft·s) = 0.45359237 / 0.3048 Pa·s.
  viscosity: [
    linear(1, "Pa·s"),
    linear(1e-3, "cP"),
    linear(1e-6, "µPa·s"),
    linear(0.45359237 / 0.3048, "lbm/(ft·s)"),
  ],
  time: [linear(1, "s"), linear(60, "min"), linear(3600, "h")],
  angle: [
    {
      id: "deg",
      symbol: "deg",
      toSI: (v) => v * (Math.PI / 180),
      fromSI: (v) => v * (180 / Math.PI),
    },
    { id: "rad", symbol: "rad", toSI: (v) => v, fromSI: (v) => v },
  ],
  dimensionless: [linear(1, "-")],
};

/**
 * Human-readable name of each quantity kind, for settings rows and chart
 * axis titles.  Exhaustive by construction: adding a QuantityKind without a
 * label here is a type error.
 */
export const QUANTITY_LABELS: Record<QuantityKind, string> = {
  pressure: "Pressure",
  temperature: "Temperature",
  length: "Length",
  area: "Area",
  volume: "Volume",
  massFlow: "Mass flow",
  massFlux: "Mass flux",
  volumetricFlow: "Volumetric flow",
  density: "Density",
  velocity: "Velocity",
  power: "Power",
  heatFlux: "Heat flux",
  thermalConductivity: "Thermal conductivity",
  heatTransferCoeff: "Heat transfer coefficient",
  specificHeat: "Specific heat",
  specificEnergy: "Specific energy",
  specificEntropy: "Specific entropy",
  viscosity: "Viscosity",
  time: "Time",
  angle: "Angle",
  dimensionless: "Dimensionless",
};

export function getUnitDef(kind: QuantityKind, unitId: UnitId): UnitDef {
  const defs = UNITS[kind];
  const def = defs.find((d) => d.id === unitId);
  if (!def) return defs[0];
  return def;
}

export function getBaseUnit(kind: QuantityKind): UnitId {
  return UNITS[kind][0].id;
}

export function convertToSI(
  kind: QuantityKind,
  value: number,
  unitId: UnitId,
): number {
  return getUnitDef(kind, unitId).toSI(value);
}

export function convertFromSI(
  kind: QuantityKind,
  value: number,
  unitId: UnitId,
): number {
  return getUnitDef(kind, unitId).fromSI(value);
}

export type UnitPreferences = Record<QuantityKind, UnitId>;

export const SI_PRESET: UnitPreferences = {
  pressure: "Pa",
  temperature: "K",
  length: "m",
  area: "m²",
  volume: "m³",
  massFlow: "kg/s",
  massFlux: "kg/(m²·s)",
  volumetricFlow: "m³/s",
  density: "kg/m³",
  velocity: "m/s",
  power: "W",
  heatFlux: "W/m²",
  thermalConductivity: "W/(m·K)",
  heatTransferCoeff: "W/(m²·K)",
  specificHeat: "J/(kg·K)",
  specificEnergy: "J/kg",
  specificEntropy: "J/(kg·K)",
  viscosity: "Pa·s",
  time: "s",
  angle: "deg",
  dimensionless: "-",
};

export const METRIC_PRESET: UnitPreferences = {
  pressure: "bar",
  temperature: "C",
  length: "mm",
  area: "cm²",
  volume: "L",
  massFlow: "kg/h",
  massFlux: "kg/(m²·s)",
  volumetricFlow: "L/min",
  density: "kg/m³",
  velocity: "m/s",
  power: "kW",
  heatFlux: "kW/m²",
  thermalConductivity: "W/(m·K)",
  heatTransferCoeff: "W/(m²·K)",
  specificHeat: "kJ/(kg·K)",
  specificEnergy: "kJ/kg",
  specificEntropy: "kJ/(kg·K)",
  viscosity: "cP",
  time: "s",
  angle: "deg",
  dimensionless: "-",
};

export const US_PRESET: UnitPreferences = {
  pressure: "psi",
  temperature: "F",
  length: "in",
  area: "in²",
  volume: "gal(US)",
  massFlow: "lbm/s",
  massFlux: "lbm/(ft²·s)",
  volumetricFlow: "gpm(US)",
  density: "lbm/ft³",
  velocity: "ft/s",
  power: "BTU/s",
  heatFlux: "BTU/(hr·ft²)",
  thermalConductivity: "BTU/(hr·ft·°F)",
  heatTransferCoeff: "BTU/(hr·ft²·°F)",
  specificHeat: "BTU/(lbm·°F)",
  specificEnergy: "BTU/lbm",
  specificEntropy: "BTU/(lbm·°R)",
  viscosity: "lbm/(ft·s)",
  time: "s",
  angle: "deg",
  dimensionless: "-",
};

export const PRESETS: Record<string, UnitPreferences> = {
  SI: SI_PRESET,
  "Metric engineering": METRIC_PRESET,
  "US customary": US_PRESET,
};

export function activeUnitPreset(preferences: UnitPreferences): string {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (
      (Object.keys(preset) as QuantityKind[]).every(
        (kind) => preset[kind] === preferences[kind],
      )
    )
      return name;
  }
  return "Custom";
}

export function formatNumber(v: number): string {
  if (!isFinite(v)) return String(v);
  if (v === 0) return "0";
  const s = v.toPrecision(6);
  // parseFloat strips trailing zeros and unnecessary scientific notation
  return parseFloat(s).toString();
}

export function formatValue(
  v: number,
  kind: QuantityKind,
  unitId: UnitId,
): string {
  const def = getUnitDef(kind, unitId);
  const valInUnit = def.fromSI(v);
  const isBase = unitId === getBaseUnit(kind);

  if (isBase) {
    const abs = Math.abs(valInUnit);
    if (kind === "pressure") {
      if (abs >= 1e6) return `${(valInUnit / 1e6).toFixed(2)} MPa`;
      if (abs >= 1e3) return `${(valInUnit / 1e3).toFixed(1)} kPa`;
      return `${valInUnit.toFixed(0)} Pa`;
    }
    if (kind === "massFlow") {
      if (abs >= 1) return `${valInUnit.toFixed(3)} kg/s`;
      if (abs >= 1e-3) return `${(valInUnit * 1000).toFixed(2)} g/s`;
      return `${(valInUnit * 1e6).toFixed(1)} mg/s`;
    }
    if (kind === "temperature") {
      return `${valInUnit.toFixed(1)} K`;
    }
    if (kind === "velocity") {
      return `${valInUnit.toFixed(2)} m/s`;
    }
    if (kind === "density") {
      return `${valInUnit.toFixed(2)} kg/m³`;
    }
  }

  const formatted = formatNumber(valInUnit);
  return `${formatted} ${def.symbol}`;
}
