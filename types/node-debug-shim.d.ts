/**
 * Minimal `process` shape for the browser project only.
 *
 * A few solver modules read Node-only debug switches behind a
 * `typeof process !== "undefined"` guard. The browser project deliberately
 * excludes @types/node, so this shim gives those guarded reads a type
 * without letting the rest of Node's global surface into application code.
 * The test and node projects use the real @types/node instead.
 */
declare const process: { env?: Record<string, string | undefined> } | undefined;
