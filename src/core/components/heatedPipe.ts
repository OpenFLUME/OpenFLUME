import type { BranchComponent } from "./branchComponent";
import { Pipe } from "./pipe";
import type { FluidModel } from "../fluids";
import { RealFluid } from "../fluids/realFluid";
import { miropolskiiPipeH } from "../correlations";
import {
  DEFAULT_CLOSURE_PARAMS,
  type ResolvedClosureParams,
} from "../closureParams";

/** Heated pipe: identical hydraulics to Pipe plus heat transfer to the stream.
 * Q = mdot·cp·(T_out − T_in) with T_out = T_wall − (T_wall − T_in)·exp(−UA/(mdot·cp)).
 * At mdot→0, Q→0 smoothly.
 * Optional `boilingModel: 'miropolskii'` replaces the crude UA·ΔT two-phase
 * fallback with the Miropolskii film-boiling correlation.
 */
export class HeatedPipe extends Pipe implements BranchComponent {
  readonly ua: number;
  readonly wallTemperature: number;
  readonly boilingModel?: "miropolskii";
  /** Resolved closure constants for the boiling-correlation branch
   *  (friction comes via Pipe's super call; default = published values). */
  readonly closureParams: ResolvedClosureParams;

  constructor(
    length: number,
    diameter: number,
    roughness: number,
    elevationChange: number,
    ua: number,
    wallTemperature: number,
    boilingModel?: "miropolskii",
    closureParams?: ResolvedClosureParams,
  ) {
    super(
      length,
      diameter,
      roughness,
      elevationChange,
      closureParams?.swameeJain,
    );
    this.ua = ua;
    this.wallTemperature = wallTemperature;
    this.boilingModel = boilingModel;
    this.closureParams = closureParams ?? DEFAULT_CLOSURE_PARAMS;
  }

  getBranchHeat(
    mdot: number,
    Tup: number,
    cp: number,
    fluid?: FluidModel,
    P?: number,
    h?: number,
  ): number {
    const mdotAbs = Math.abs(mdot);
    if (fluid && P !== undefined && h !== undefined) {
      let ph: { phase: string; T?: number } | undefined;
      try {
        ph = fluid.statePH(P, h);
      } catch {
        return 0;
      }
      if (ph && ph.phase === "twoPhase") {
        if (this.boilingModel === "miropolskii" && fluid instanceof RealFluid) {
          const hMiro = miropolskiiPipeH(
            mdot,
            this.diameter,
            fluid,
            P,
            h,
            this.closureParams,
          );
          const Ainner = Math.PI * this.diameter * this.length;
          const Tsat = fluid.saturationTemperature(P);
          return hMiro * Ainner * (this.wallTemperature - Tsat);
        }
        return this.ua * (this.wallTemperature - Tup);
      }
    }
    const NTU = this.ua / (mdotAbs * cp);
    const epsilon = 1 - Math.exp(-NTU);
    return mdotAbs * cp * epsilon * (this.wallTemperature - Tup);
  }
}
