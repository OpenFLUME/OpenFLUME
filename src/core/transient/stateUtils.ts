import type { StepState } from "../solver";

export function cloneState(state: StepState): StepState {
  return {
    nodeP: new Map(state.nodeP),
    nodeT: new Map(state.nodeT),
    nodeRho: new Map(state.nodeRho),
    nodeMu: new Map(state.nodeMu),
    nodeH: state.nodeH ? new Map(state.nodeH) : undefined,
    nodeQuality: state.nodeQuality ? new Map(state.nodeQuality) : undefined,
    nodePhase: state.nodePhase ? new Map(state.nodePhase) : undefined,
    nodeY: state.nodeY ? new Map(state.nodeY) : undefined,
    mdots: [...state.mdots],
    solidT: new Map(state.solidT),
  };
}
