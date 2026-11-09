/**
 * mrs-validation-run.ts — run the OpenFLUME MRS radiator network for the test
 * points of docs/validation/mrs-protocol.md and write per-panel results.
 *
 *   npx tsx scripts/mrs-validation-run.ts --variant base --out /tmp/mrs-base.json
 *   npx tsx scripts/mrs-validation-run.ts --variant seg16 --points 1A,51 --out ...
 *
 * Options
 *   --variant NAME   one of MRS_VARIANTS (default base)
 *   --points a,b,c   test points (default the primary set of the registry)
 *   --set all        every registry point that has a transcribed map (primary,
 *                    secondary and excluded with flows), not just the primary set
 *   --segments N     override the number of segments per tube of the variant
 *   --out FILE       JSON output, rewritten after every test point so a long
 *                    run can be polled
 *
 * One OpenFLUME network is solved per panel and legs are chained through the
 * panel mixing state (see solveMrsLegChained).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initRealFluids } from "../src/core/fluids/coolprop";
import {
  MRS_VARIANTS,
  solveMrsLegChained,
  LBHR_TO_KGS,
  type MrsPanelRun,
} from "../src/validation/mrsRadiator";
import { readRegistry } from "../src/validation/mrsData";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const variantName = arg("variant") ?? "base";
const variant = { ...MRS_VARIANTS[variantName] };
if (!MRS_VARIANTS[variantName])
  throw new Error(`unknown variant ${variantName}`);
const segOverride = arg("segments");
if (segOverride !== undefined)
  variant.options = { ...variant.options, segments: Number(segOverride) };
const outFile = arg("out");
const DATA = join("validation", "data", "digitized", "mrs");
const registry = readRegistry(
  readFileSync(join(DATA, "mrs_test_point_registry.csv"), "utf8"),
);
const wanted = arg("points")?.split(",");
const points = registry.filter((r) =>
  wanted
    ? wanted.includes(r.testPoint)
    : arg("set") === "all"
      ? r.legs.length > 0 && r.fractions.length > 0
      : r.set === "primary",
);

interface Row extends MrsPanelRun {
  variant: string;
  testPoint: string;
  leg: string;
}

await initRealFluids();
const rows: Row[] = [];
const t0 = performance.now();
for (const entry of points) {
  const sides = variant.sidesOverride?.[entry.testPoint] ?? entry.sides;
  entry.legs.forEach((panels, li) => {
    const leg = {
      panels,
      mdot: entry.totalFlowLbhr * entry.fractions[li] * LBHR_TO_KGS,
      tinF: entry.tinF,
      flux: entry.flux,
      sides,
    };
    for (const run of solveMrsLegChained(leg, variant.options)) {
      rows.push({
        variant: variantName,
        testPoint: entry.testPoint,
        leg: panels.join("-"),
        ...run,
      });
    }
  });
  if (outFile) writeFileSync(outFile, JSON.stringify(rows));
  console.log(
    `${variantName} TP${entry.testPoint} done, ${rows.length} panels, ${((performance.now() - t0) / 1000).toFixed(0)} s`,
  );
}
if (outFile) writeFileSync(outFile, JSON.stringify(rows));
