import type { TransientResult } from "../schema";

export interface SolveTransientOptions {
  onProgress?: (p: {
    step: number;
    totalSteps?: number;
    time: number;
    endTime: number;
    dt?: number;
    partial: TransientResult;
  }) => void;
  progressInterval?: number;
  shouldAbort?: () => boolean;
}
