/** Static formula fields shared by decoding, resolution, and UI discovery. */
export const BINDABLE_NODE_FIELDS = [
  "pressure",
  "temperature",
  "volume",
  "heatInput",
] as const;
export const BINDABLE_SOLID_FIELDS = [
  "temperature",
  "mass",
  "heatInput",
] as const;
export const BINDABLE_POSITION_AXES = ["x", "y", "z"] as const;

export const BINDABLE_COMPONENT_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  pipe: ["length", "diameter", "roughness", "elevationChange"],
  heatedPipe: [
    "length",
    "diameter",
    "roughness",
    "elevationChange",
    "ua",
    "wallTemperature",
  ],
  bend: ["diameter", "rOverD", "roughness"],
  orifice: ["area", "cd"],
  orificeCompressible: ["area", "cd"],
  cavitatingVenturi: ["throatArea", "cd", "recoveryFactor"],
  resistance: ["k", "area"],
  valve: ["area", "cd", "position"],
  checkValve: ["area", "cd"],
  dynamicCheckValve: [
    "area",
    "cd",
    "discArea",
    "mass",
    "springRate",
    "preload",
    "damping",
    "stroke",
    "initialPosition",
  ],
  reliefValve: ["crackPressure", "fullOpenPressure", "area", "cd"],
  pump: [],
  areaChange: ["areaIn", "areaOut"],
  flowSource: ["massFlow"],
  regulator: ["setPressure", "maxCdA"],
  dpTable: [],
  customResistance: ["area", "diameter"],
  userComponent: ["area"],
};

export const BINDABLE_CONDUCTOR_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  conduction: ["area", "length"],
  convection: ["h", "area"],
  radiation: ["emissivity", "area", "viewFactor"],
};

export const BINDABLE_CORRELATION_FIELDS = [
  "diameter",
  "flowArea",
  "axialPosition",
  "inletLiquidReynolds",
  "segmentLength",
  "frontEnergyFactor",
  "rewetHysteresisOffsetK",
] as const;
