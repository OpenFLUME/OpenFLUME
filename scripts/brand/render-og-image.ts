/**
 * Renders the 1280×640 social preview image (OpenGraph / Twitter card /
 * GitHub social preview) from scripts/brand/og-image.html.
 *
 *   npx tsx scripts/brand/render-og-image.ts
 *
 * Writes public/og-image.png (served at <base>/og-image.png) and copies it to
 * docs/public/og-image.png for the docs site.
 */
import { chromium } from "@playwright/test";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = path.join(root, "public/og-image.png");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.goto(pathToFileURL(path.join(here, "og-image.html")).href);
await page.waitForLoadState("networkidle");
await page.screenshot({ path: out, type: "png" });
await browser.close();
copyFileSync(out, path.join(root, "docs/public/og-image.png"));
console.log(`wrote ${path.relative(root, out)}`);
