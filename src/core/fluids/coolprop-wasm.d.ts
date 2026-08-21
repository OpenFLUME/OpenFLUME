declare module "coolprop-wasm" {
  /**
   * embind enum wrapper. Derivative APIs (`first_partial_deriv`,
   * `first_saturation_deriv`) must be passed these OBJECTS — passing the raw
   * `.value` number silently coerces to parameter key 0 and throws
   * "Unable to match the key [0] in get_parameter_information".
   */
  export interface EnumValue {
    readonly value: number;
  }

  /** CoolProp::parameters enum (subset used here, plus index signature). */
  export interface ParametersEnum {
    readonly iP: EnumValue;
    readonly iT: EnumValue;
    readonly iQ: EnumValue;
    readonly iDmass: EnumValue;
    readonly iHmass: EnumValue;
    readonly iSmass: EnumValue;
    readonly iUmass: EnumValue;
    readonly iviscosity: EnumValue;
    readonly iconductivity: EnumValue;
    readonly [key: string]: EnumValue;
  }

  export interface AbstractState {
    update(input_pair: number, value1: number, value2?: number): void;
    rhomass(): number;
    hmass(): number;
    umass(): number;
    cpmass(): number;
    cvmass(): number;
    viscosity(): number;
    T(): number;
    Q(): number;
    phase(): unknown;
    conductivity?(): number;
    /** Absolute specific entropy [J/(kg·K)]. */
    smass?(): number;
    /** Isentropic speed of sound [m/s]; throws inside the two-phase dome. */
    speed_sound?(): number;
    first_partial_deriv(
      of: EnumValue,
      wrt: EnumValue,
      constant: EnumValue,
    ): number;
    first_saturation_deriv(of: EnumValue, wrt: EnumValue): number;
  }

  export interface CoolPropModule {
    PropsSI(
      output: string,
      name1: string,
      value1: number,
      name2: string,
      value2: number,
      fluid: string,
    ): number;
    factory(backend: string, fluids: string): AbstractState;
    input_pairs: Record<string, number>;
    parameters: ParametersEnum;
    /**
     * CoolProp::get_global_param_string — e.g. 'fluids_list' (comma-separated
     * canonical HEOS names), 'version'.  Used by the catalogue generator
     * (scripts/build-fluid-catalogue.ts); the app itself never calls it.
     */
    get_global_param_string(param: string): string;
    /**
     * CoolProp::get_fluid_param_string — per-fluid string metadata such as
     * 'CAS', 'aliases' (comma-separated) and 'pure' ('true'/'false').
     */
    get_fluid_param_string(fluid: string, param: string): string;
  }

  export default function CoolPropModule(): Promise<CoolPropModule>;
}
