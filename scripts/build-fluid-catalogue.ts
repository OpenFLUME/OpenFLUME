/**
 * Generator for src/core/fluids/generated/fluidCatalogue.ts — the static
 * CoolProp HEOS fluid catalogue consumed by validation and the Settings UI.
 *
 * Usage:
 *   npm run gen:fluid-catalogue            (regenerate the catalogue file)
 *   tsx scripts/build-fluid-catalogue.ts --check   (diff-only, exit 1 on drift)
 *
 * Design notes (see docs/fluid-catalogue.md):
 *
 *  - The fluid list comes from CoolProp's own
 *    `get_global_param_string('fluids_list')` so the catalogue can never drift
 *    from the WASM build we ship.  Per-fluid CAS / aliases / pure flags come
 *    from `get_fluid_param_string` — pure string calls that cannot flash a
 *    state and are safe to run in-process.
 *
 *  - TRANSPORT probing (does a viscosity / thermal-conductivity model exist?)
 *    requires flashing an AbstractState, and some fluids abort the WASM heap
 *    on certain inputs (the same failure mode realFluid.ts defends against).
 *    An abort can poison the heap for every subsequent fluid, so each fluid
 *    is probed in a FRESH child process (`--probe-child <name>`).  The parent
 *    aggregates child JSON output; a crashed/timed-out child yields
 *    'unknown' rather than a guess.  None of this probing ever runs at app
 *    runtime — validation and the picker read only the generated file.
 *
 *  - No INCOMP fluids, no REFPROP-only strings, no arbitrary mixtures: the
 *    catalogue is exactly the HEOS `fluids_list` of the shipped coolprop-wasm
 *    build, sorted by code point for deterministic diffs.
 */
import { execFile } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const OUT_PATH = path.resolve(
  path.dirname(SCRIPT_PATH),
  "../src/core/fluids/generated/fluidCatalogue.ts",
);

const PROBE_TIMEOUT_MS = 120_000;
const PROBE_CONCURRENCY = 8;

type TransportFlag = "yes" | "no" | "unknown";

interface ProbeResult {
  viscosity: TransportFlag;
  conductivity: TransportFlag;
  flashed: number;
}

interface CatalogueEntry {
  name: string;
  cas: string;
  pure: boolean;
  aliases: string[];
  transport: { viscosity: TransportFlag; conductivity: TransportFlag };
}

/* ------------------------------------------------------------------------ */
/* Child mode: probe ONE fluid in a pristine WASM heap, print JSON, exit.    */
/* ------------------------------------------------------------------------ */

async function probeChild(fluidName: string): Promise<void> {
  const mod = await import("coolprop-wasm");
  const cp = (await mod.default()) as any;

  const constant = (key: string): number => {
    try {
      return cp.PropsSI(key, "", 0, "", 0, fluidName);
    } catch {
      return NaN;
    }
  };
  const Tc = constant("TCRIT");
  const Pc = constant("PCRIT");
  const Tmin = constant("TMIN");
  const Tmax = constant("TMAX");
  const clamp = (x: number, a: number, b: number) =>
    Math.min(Math.max(x, a), b);

  // Benign probe states, most-robust first.  Each gets a FRESH AbstractState:
  // reusing a state across updates is exactly what corrupts the heap for the
  // known-fragile fluids.
  const candidates: Array<["PT" | "PQ", number, number]> = [];
  if (isFinite(Tc) && isFinite(Tmin) && isFinite(Tmax)) {
    // Low-pressure gas well above Tc (superheated vapour for every fluid).
    candidates.push(["PT", 101325, clamp(1.6 * Tc, Tmin + 1, Tmax - 1)]);
  }
  const Psat = isFinite(Pc) ? Math.min(1e5, 0.3 * Pc) : 1e5;
  candidates.push(["PQ", Psat, 1]); // saturated vapour
  candidates.push(["PQ", Psat, 0]); // saturated liquid
  if (isFinite(Tc) && isFinite(Pc)) {
    // Supercritical single-phase.
    candidates.push([
      "PT",
      Math.min(Math.max(2 * Pc, 2e6), 1e8),
      clamp(
        1.1 * Tc,
        (isFinite(Tmin) ? Tmin : 1) + 1,
        (isFinite(Tmax) ? Tmax : 2000) - 1,
      ),
    ]);
  }

  let viscosity: TransportFlag = "unknown";
  let conductivity: TransportFlag = "unknown";
  let flashed = 0;

  for (const [kind, P, V] of candidates) {
    try {
      const st = cp.factory("HEOS", fluidName);
      if (kind === "PT") st.update(cp.input_pairs.PT_INPUTS, P, V);
      else st.update(cp.input_pairs.PQ_INPUTS, P, V);
      if (kind === "PT") {
        const q = st.Q();
        if (q >= 0 && q <= 1) continue; // exactly on the saturation curve — skip
      }
      flashed++;
      if (viscosity !== "yes") {
        try {
          const v = st.viscosity();
          if (isFinite(v) && v > 0) viscosity = "yes";
          else if (viscosity === "unknown") viscosity = "no";
        } catch {
          if (viscosity === "unknown") viscosity = "no";
        }
      }
      if (conductivity !== "yes") {
        try {
          const k = st.conductivity();
          if (isFinite(k) && k > 0) conductivity = "yes";
          else if (conductivity === "unknown") conductivity = "no";
        } catch {
          if (conductivity === "unknown") conductivity = "no";
        }
      }
    } catch {
      // state failed to flash — try the next candidate
    }
    if (viscosity === "yes" && conductivity === "yes") break;
  }

  // 'no' is only asserted when at least one state flashed successfully;
  // otherwise the model status is genuinely undeterminable here.
  if (flashed === 0) {
    viscosity = "unknown";
    conductivity = "unknown";
  }
  process.stdout.write(
    JSON.stringify({ viscosity, conductivity, flashed } satisfies ProbeResult),
  );
  process.exit(0);
}

/* ------------------------------------------------------------------------ */
/* Parent mode                                                               */
/* ------------------------------------------------------------------------ */

function runProbeChild(fluidName: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--import", "tsx", SCRIPT_PATH, "--probe-child", fluidName],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          resolve({
            viscosity: "unknown",
            conductivity: "unknown",
            flashed: 0,
          });
          return;
        }
        // The WASM runtime may print "Aborted(...)" noise on stderr; stdout
        // carries exactly one JSON document from a successful child.
        try {
          resolve(JSON.parse(stdout.trim()) as ProbeResult);
        } catch {
          resolve({
            viscosity: "unknown",
            conductivity: "unknown",
            flashed: 0,
          });
        }
      },
    );
    child.stderr?.resume(); // discard
  });
}

async function probeAll(names: string[]): Promise<Map<string, ProbeResult>> {
  const results = new Map<string, ProbeResult>();
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < names.length) {
      const name = names[next++];
      const r = await runProbeChild(name);
      results.set(name, r);
      done++;
      if (done % 16 === 0 || done === names.length) {
        process.stderr.write(`  probed ${done}/${names.length}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
  return results;
}

function emitFile(entries: CatalogueEntry[], version: string): string {
  const lines: string[] = [];
  lines.push(`/**`);
  lines.push(` * GENERATED FILE — do not edit by hand.`);
  lines.push(` * Regenerate with: npm run gen:fluid-catalogue`);
  lines.push(` * (script: scripts/build-fluid-catalogue.ts)`);
  lines.push(` *`);
  lines.push(
    ` * Source: coolprop-wasm ${version} — CoolProp::get_global_param_string('fluids_list')`,
  );
  lines.push(
    ` * plus per-fluid get_fluid_param_string(name, 'CAS' | 'aliases' | 'pure').`,
  );
  lines.push(
    ` * Transport flags were probed in isolated child processes (a WASM abort on`,
  );
  lines.push(
    ` * one fluid can poison the heap for the next — see the script header).`,
  );
  lines.push(` *`);
  lines.push(
    ` * Scope: HEOS pure and pseudo-pure fluids ONLY.  No INCOMP fluids, no`,
  );
  lines.push(` * REFPROP-only names, no arbitrary mixture strings.`);
  lines.push(` */`);
  lines.push(`export type FluidTransportFlag = 'yes' | 'no' | 'unknown';`);
  lines.push(``);
  lines.push(`export interface FluidCatalogueEntry {`);
  lines.push(
    `  /** Canonical HEOS name (exactly as it appears in fluids_list). */`,
  );
  lines.push(`  readonly name: string;`);
  lines.push(
    `  /** CAS registry number, or a pseudo-pure identifier such as "R404A.PPF". */`,
  );
  lines.push(`  readonly cas: string;`);
  lines.push(
    `  /** true = pure fluid; false = pseudo-pure mixture (Air, R404A, …). */`,
  );
  lines.push(`  readonly pure: boolean;`);
  lines.push(
    `  /** CoolProp-registered aliases (the canonical name is not repeated). */`,
  );
  lines.push(`  readonly aliases: readonly string[];`);
  lines.push(`  /**`);
  lines.push(`   * Transport-model availability, probed at generation time:`);
  lines.push(
    `   *  - 'yes'     a model exists and returned a finite positive value;`,
  );
  lines.push(
    `   *  - 'no'      a state flashed successfully but the model is absent;`,
  );
  lines.push(
    `   *  - 'unknown' no probe state flashed — treat as absent for validation,`,
  );
  lines.push(`   *             but do not hard-depend on it.`);
  lines.push(`   */`);
  lines.push(`  readonly transport: {`);
  lines.push(`    readonly viscosity: FluidTransportFlag;`);
  lines.push(`    readonly conductivity: FluidTransportFlag;`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(
    `/** Every HEOS fluid of the shipped coolprop-wasm build, sorted by name. */`,
  );
  lines.push(`export const FLUID_CATALOGUE = [`);
  for (const e of entries) {
    const aliases = e.aliases.map((a) => JSON.stringify(a)).join(", ");
    lines.push(
      `  { name: ${JSON.stringify(e.name)}, cas: ${JSON.stringify(e.cas)}, pure: ${e.pure}, ` +
        `aliases: [${aliases}], transport: { viscosity: '${e.transport.viscosity}', conductivity: '${e.transport.conductivity}' } },`,
    );
  }
  lines.push(`] as const satisfies readonly FluidCatalogueEntry[];`);
  lines.push(``);
  lines.push(
    `/** Union of every canonical HEOS fluid name in the shipped build. */`,
  );
  lines.push(
    `export type HeosFluidName = (typeof FLUID_CATALOGUE)[number]['name'];`,
  );
  lines.push(``);
  lines.push(`export const FLUID_CATALOGUE_COUNT = FLUID_CATALOGUE.length;`);
  lines.push(``);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--probe-child") {
    await probeChild(args[1]);
    return;
  }
  const checkOnly = args.includes("--check");

  const mod = await import("coolprop-wasm");
  const cp = (await mod.default()) as any;
  let version = "unknown";
  try {
    version = cp.get_global_param_string("version");
  } catch {
    // older builds may not expose it — the catalogue header just says 'unknown'
  }

  const names: string[] = String(cp.get_global_param_string("fluids_list"))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  names.sort(); // code-point sort: deterministic diffs regardless of CoolProp ordering

  process.stderr.write(`CoolProp ${version}: ${names.length} HEOS fluids\n`);

  // String-only metadata — safe in-process (no state flashing involved).
  const meta = new Map<
    string,
    { cas: string; pure: boolean; aliases: string[] }
  >();
  for (const name of names) {
    let cas = "";
    let pure = true;
    let aliases: string[] = [];
    try {
      cas = cp.get_fluid_param_string(name, "CAS");
    } catch {
      cas = "";
    }
    try {
      pure = cp.get_fluid_param_string(name, "pure") === "true";
    } catch {
      pure = true;
    }
    try {
      aliases = String(cp.get_fluid_param_string(name, "aliases"))
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } catch {
      aliases = [];
    }
    meta.set(name, { cas, pure, aliases });
  }

  // Transport probes — isolated child processes (see header).
  const probes = await probeAll(names);

  const entries: CatalogueEntry[] = names.map((name) => {
    const m = meta.get(name)!;
    const p = probes.get(name) ?? {
      viscosity: "unknown",
      conductivity: "unknown",
      flashed: 0,
    };
    return {
      name,
      cas: m.cas,
      pure: m.pure,
      aliases: m.aliases,
      transport: { viscosity: p.viscosity, conductivity: p.conductivity },
    };
  });

  const output = emitFile(entries, version);

  if (checkOnly) {
    let current = "";
    try {
      current = readFileSync(OUT_PATH, "utf8");
    } catch {
      // missing file counts as drift
    }
    if (current === output) {
      process.stderr.write("fluid catalogue is up to date\n");
      return;
    }
    process.stderr.write(
      `fluid catalogue is STALE — run npm run gen:fluid-catalogue\n`,
    );
    process.exit(1);
  }

  writeFileSync(OUT_PATH, output);
  const noV = entries.filter((e) => e.transport.viscosity !== "yes");
  process.stderr.write(
    `wrote ${OUT_PATH}: ${entries.length} fluids, ` +
      `${entries.filter((e) => !e.pure).length} pseudo-pure, ` +
      `${noV.length} without a confirmed viscosity model (${noV.map((e) => e.name).join(", ")})\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
