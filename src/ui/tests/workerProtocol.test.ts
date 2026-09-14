/**
 * workerProtocol — the client narrows whatever arrives on the wire to the
 * shared message union before acting on it. Unknown or malformed messages
 * are dropped whole rather than half-trusted.
 */
import { describe, it, expect } from "vitest";
import {
  parseWorkerToMainMessage,
  type WorkerToMainMessage,
} from "../workerProtocol";

describe("parseWorkerToMainMessage", () => {
  it("accepts every well-formed message kind", () => {
    const messages: WorkerToMainMessage[] = [
      { type: "ready" },
      { type: "coolpropLoading" },
      {
        type: "progress",
        payload: { kind: "steady", iteration: 3, residual: 1e-4 },
      },
      { type: "error", message: "boom" },
    ];
    for (const m of messages) expect(parseWorkerToMainMessage(m)).toEqual(m);
    const done = parseWorkerToMainMessage({
      type: "done",
      result: { converged: true },
    });
    expect(done?.type).toBe("done");
  });

  it("rejects non-objects, unknown types and malformed bodies", () => {
    expect(parseWorkerToMainMessage(null)).toBeNull();
    expect(parseWorkerToMainMessage("done")).toBeNull();
    expect(parseWorkerToMainMessage({ type: "bogus" })).toBeNull();
    expect(parseWorkerToMainMessage({ type: "progress" })).toBeNull();
    expect(
      parseWorkerToMainMessage({ type: "progress", payload: { kind: "x" } }),
    ).toBeNull();
    expect(parseWorkerToMainMessage({ type: "done" })).toBeNull();
    expect(parseWorkerToMainMessage({ type: "done", result: 42 })).toBeNull();
  });

  it("gives an error message a readable default", () => {
    expect(parseWorkerToMainMessage({ type: "error" })).toEqual({
      type: "error",
      message: "Unknown worker error",
    });
  });
});
