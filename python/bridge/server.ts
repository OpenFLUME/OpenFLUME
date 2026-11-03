/**
 * Python bridge: a long-lived Node process that exposes the OpenFLUME core
 * to the `openflume` Python package over newline-delimited JSON on stdio.
 *
 * Bundled (with coolprop.wasm beside it) by `npm run build:python` into
 * python/src/openflume/_js/; the Python side spawns it once per session.
 *
 * Protocol — one JSON object per line:
 *   request   {"id": n, "method": "...", "params": {...}}
 *   response  {"id": n, "result": ...}
 *             {"id": n, "error": {"type", "message", "code"?, "path"?, "stack"?}}
 *   event     {"id": n, "event": "progress", "data": {...}}   (opt-in, ≤10/s)
 *
 * Requests are handled strictly one at a time (the solvers are synchronous).
 * Non-finite numbers cannot travel as JSON, so both directions encode them as
 * the sentinel objects {"$num": "NaN" | "Infinity" | "-Infinity"}; the Python
 * client decodes them back to float('nan') / ±inf.
 *
 * stdout is reserved for the protocol: console output from the core (or from
 * embedded user components) is redirected to stderr, which the Python client
 * forwards to its logger.
 *
 * Mirrors src/ui/solverWorker.ts: decode → validate → lazy CoolProp init →
 * solve.  Embedded componentLibrary code runs with full Node privileges, the
 * same as using the TypeScript core directly (docs/usercode.md "Security
 * Model"); only run models you trust.
 */
import { createInterface } from "node:readline";
import {
  ConfigDecodeError,
  FLUID_CATALOGUE,
  CURATED_REAL_FLUIDS,
  SUPPORTED_CONFIG_VERSION,
  assessResult,
  assessModelReadiness,
  combustionGasBounds,
  createFluidModel,
  decodeNetworkConfig,
  initRealFluids,
  listCombustionPropellants,
  lookupCombustionGas,
  networkUsesRealFluid,
  solveSteady,
  solveTransient,
  validateNetwork,
  type CombustionPropellants,
  type FluidModel,
  type NetworkConfig,
} from "../../src/core";
import { parseText, serializeText } from "../../src/substrate/textProjection";
import { examples } from "../../src/ui/examples";

declare const __OPENFLUME_VERSION__: string;

const PROTOCOL_VERSION = 1;

// ── stdout hygiene ───────────────────────────────────────────────────────
const writeOut = process.stdout.write.bind(process.stdout);
for (const level of ["log", "info", "debug", "warn", "trace"] as const) {
  console[level] = (...args: unknown[]) => console.error(...args);
}
process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean =>
  process.stderr.write(
    chunk as string,
    ...(rest as []),
  )) as typeof process.stdout.write;

// ── non-finite number encoding ───────────────────────────────────────────
const NUM_TAG = "$num";

function encode(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "number" && !Number.isFinite(v)) {
      return {
        [NUM_TAG]: Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity",
      };
    }
    return v;
  });
}

function decode(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      const keys = Object.keys(rec);
      if (keys.length === 1 && keys[0] === NUM_TAG) {
        return Number(rec[NUM_TAG]);
      }
    }
    return v;
  });
}

function send(message: Record<string, unknown>): void {
  writeOut(encode(message) + "\n");
}

// ── helpers ──────────────────────────────────────────────────────────────
class BridgeError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Params = Record<string, unknown>;

function requireConfig(params: Params): NetworkConfig {
  try {
    // decodeNetworkConfig migrates legacy fields in place; the input is a
    // freshly parsed message so there is no caller-visible aliasing.
    return decodeNetworkConfig(params.config);
  } catch (err) {
    if (err instanceof ConfigDecodeError) {
      throw new BridgeError("ConfigDecodeError", err.message, {
        code: err.code,
        path: err.path,
      });
    }
    throw err;
  }
}

function requireValid(config: NetworkConfig): void {
  const errors = validateNetwork(config);
  if (errors.length > 0) {
    throw new BridgeError(
      "ValidationError",
      `network failed validation (${errors.length} error${errors.length === 1 ? "" : "s"})`,
      { errors },
    );
  }
}

async function ensureRealFluids(config: NetworkConfig): Promise<void> {
  if (networkUsesRealFluid(config)) await initRealFluids();
}

function throttled<T>(id: number, enabled: boolean, map: (p: T) => unknown) {
  if (!enabled) return undefined;
  let last = 0;
  let sent = false;
  return (p: T) => {
    const now = performance.now();
    if (sent && now - last < 100) return;
    sent = true;
    last = now;
    send({ id, event: "progress", data: map(p) });
  };
}

// Fluid models are cached per spec so repeated property calls reuse the
// CoolProp handle and its LRU caches.
const fluidCache = new Map<string, FluidModel>();

async function fluidFor(params: Params): Promise<FluidModel> {
  const spec = (params.fluid ?? {}) as {
    model?: string;
    preset?: string;
    params?: Record<string, number | string>;
  };
  const key = encode(spec);
  const cached = fluidCache.get(key);
  if (cached) return cached;
  const model = spec.model ?? "realFluid";
  if (model === "realFluid") await initRealFluids();
  const fluid = createFluidModel(
    model as Parameters<typeof createFluidModel>[0],
    spec.preset as Parameters<typeof createFluidModel>[1],
    spec.params,
  );
  fluidCache.set(key, fluid);
  return fluid;
}

const FLUID_METHODS = new Set([
  "density",
  "viscosity",
  "cp",
  "cv",
  "enthalpy",
  "internalEnergy",
  "temperatureFromEnthalpy",
  "temperatureFromInternalEnergy",
  "saturationTemperature",
  "hSatLiquid",
  "hSatVapor",
  "rhoSatLiquid",
  "rhoSatVapor",
  "criticalPressure",
  "criticalTemperature",
  "statePH",
  "enthalpyPT",
  "enthalpyPQ",
  "internalEnergyPH",
  "entropy",
  "speedOfSound",
  "thermalConductivity",
]);

// ── methods ──────────────────────────────────────────────────────────────
type Handler = (params: Params, id: number) => unknown;

const methods: Record<string, Handler> = {
  hello: () => ({
    protocol: PROTOCOL_VERSION,
    version: __OPENFLUME_VERSION__,
    configVersion: SUPPORTED_CONFIG_VERSION,
    node: process.versions.node,
  }),

  parseText: (params) => {
    const res = parseText(String(params.text ?? ""));
    return { config: res.config ?? null, errors: res.errors };
  },

  serializeText: (params) => serializeText(requireConfig(params)),

  decode: (params) => requireConfig(params),

  validate: (params) => {
    const config = requireConfig(params);
    return { config, errors: validateNetwork(config) };
  },

  readiness: (params) => assessModelReadiness(requireConfig(params)),

  solve: async (params, id) => {
    const config = requireConfig(params);
    requireValid(config);
    const mode = (params.mode as string | undefined) ?? config.settings.mode;
    if (mode !== "steady" && mode !== "transient") {
      throw new BridgeError(
        "ValueError",
        `unknown solve mode ${JSON.stringify(mode)}`,
      );
    }
    await ensureRealFluids(config);
    const progress = params.progress === true;
    if (mode === "transient") {
      config.settings.mode = "transient";
      const result = solveTransient(config, {
        onProgress: throttled(id, progress, (p) => ({
          kind: "transient",
          step: p.step,
          totalSteps: p.totalSteps,
          time: p.time,
          endTime: p.endTime,
          dt: p.dt,
        })),
      });
      return { mode, result };
    }
    config.settings.mode = "steady";
    const result = solveSteady(config, {
      onProgress: throttled(id, progress, (p) => ({
        kind: "steady",
        iteration: p.iteration,
        residual: p.residual,
      })),
    });
    return { mode, result };
  },

  assessResult: (params) =>
    assessResult(requireConfig(params), params.result as never),

  examples: () => Object.keys(examples),

  example: (params) => {
    const name = String(params.name ?? "");
    const config = examples[name];
    if (!config) {
      throw new BridgeError(
        "KeyError",
        `unknown example ${JSON.stringify(name)}`,
        {
          available: Object.keys(examples),
        },
      );
    }
    return structuredClone(config);
  },

  fluidCatalogue: () => ({
    fluids: FLUID_CATALOGUE,
    curated: CURATED_REAL_FLUIDS,
  }),

  fluidProperty: async (params) => {
    const method = String(params.method ?? "");
    if (!FLUID_METHODS.has(method)) {
      throw new BridgeError(
        "ValueError",
        `unsupported fluid property ${JSON.stringify(method)}`,
      );
    }
    const fluid = await fluidFor(params);
    const fn = (fluid as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      throw new BridgeError(
        "NotImplementedError",
        `fluid model does not provide ${method}`,
      );
    }
    const call = fn as (...a: number[]) => unknown;
    const rows = (params.args ?? []) as number[][];
    return rows.map((row) => call.apply(fluid, row));
  },

  combustionPropellants: () =>
    listCombustionPropellants().map((p) => ({
      propellants: p,
      bounds: combustionGasBounds(p),
    })),

  combustionGas: (params) =>
    lookupCombustionGas(
      params.propellants as CombustionPropellants,
      Number(params.pc),
      Number(params.of),
    ),
};

// ── loop ─────────────────────────────────────────────────────────────────
function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof BridgeError) {
    return { type: err.type, message: err.message, ...err.extra };
  }
  if (err instanceof Error) {
    return {
      type: err.name || "Error",
      message: err.message,
      stack: err.stack,
    };
  }
  return { type: "Error", message: String(err) };
}

async function handle(line: string): Promise<void> {
  let id = -1;
  try {
    const msg = decode(line) as {
      id?: number;
      method?: string;
      params?: Params;
    };
    id = typeof msg.id === "number" ? msg.id : -1;
    const handler = msg.method ? methods[msg.method] : undefined;
    if (!handler) {
      throw new BridgeError(
        "ValueError",
        `unknown method ${JSON.stringify(msg.method)}`,
      );
    }
    const result = await handler(msg.params ?? {}, id);
    send({ id, result: result ?? null });
  } catch (err) {
    send({ id, error: errorPayload(err) });
  }
}

let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  queue = queue.then(() => handle(line));
});
rl.on("close", () => {
  void queue.then(() => process.exit(0));
});
