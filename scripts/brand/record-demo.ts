/**
 * Records the short README / social demo: open a shared example link, run
 * the transient, plot tank pressure versus time, then recolor the canvas by
 * pressure and scrub through time.
 *
 *   npm run build && npx tsx scripts/brand/record-demo.ts
 *
 * Needs ffmpeg on PATH. Writes:
 *   docs/public/demo.mp4  (H.264; for posts, the docs site, and social video)
 *   docs/figures/demo.gif (palette-optimised; for the README)
 *
 * The run must converge; a failed run aborts rather than publishing a demo of
 * a failure.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { createServer } from "../serve";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DIST = path.join(ROOT, "dist");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4177);
const VIEWPORT = { width: 1280, height: 760 };

const id = (page: Page, testId: string) =>
  page.locator(`[data-testid="${testId}"]`);

async function pause(page: Page, ms: number) {
  await page.waitForTimeout(ms);
}

async function record(baseURL: string, videoDir: string): Promise<string> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "dark",
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  const page = await context.newPage();
  try {
    await page.goto(baseURL);
    await page.evaluate(() => localStorage.clear());
    await page.addStyleTag({
      content: ".selection-menu { display: none !important; }",
    });
    // The point of the demo: a link opens a working model.
    await page.goto(`${baseURL}#example=tank-blowdown`);
    await page.reload();
    await id(page, "toolbar-run").waitFor({ state: "visible" });
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height - 140);
    await pause(page, 1500);

    await id(page, "toolbar-run").hover();
    await pause(page, 400);
    await id(page, "toolbar-run").click();
    await page.waitForFunction(
      () =>
        /converged|steps|failed|diverged/i.test(
          document.querySelector('[data-testid="toolbar-status"]')
            ?.textContent ?? "",
        ),
      undefined,
      { timeout: 60_000 },
    );
    const status =
      (await id(page, "toolbar-status").textContent())?.trim() ?? "";
    if (/failed|diverged/i.test(status)) {
      throw new Error(`Run did not converge: ${status}`);
    }
    await pause(page, 900);

    await id(page, "results-tab").click();
    await id(page, "plot-x-axis").waitFor({ state: "visible" });
    await id(page, "plot-channel-preset").selectOption("node-pressure");
    await page.locator('[data-testid="plot-chart"] polyline').first().waitFor();
    await pause(page, 2200);

    await id(page, "editor-tab").click();
    await id(page, "color-by-select").selectOption({ label: "Pressure" });
    const scrubber = id(page, "time-scrubber");
    await scrubber.waitFor({ state: "visible" });
    await pause(page, 800);
    const slider = scrubber.locator('input[type="range"]').first();
    if (await slider.count()) {
      const box = await slider.boundingBox();
      if (box) {
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + 2, y);
        await page.mouse.down();
        for (let i = 0; i <= 30; i++) {
          await page.mouse.move(box.x + 2 + ((box.width - 4) * i) / 30, y);
          await pause(page, 70);
        }
        await page.mouse.up();
      }
    }
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height - 140);
    await pause(page, 1800);
  } finally {
    await context.close();
    await browser.close();
  }
  const [webm] = fs.readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("Playwright did not write a video.");
  return path.join(videoDir, webm);
}

function encode(webm: string) {
  const mp4 = path.join(ROOT, "docs/public/demo.mp4");
  const gif = path.join(ROOT, "docs/figures/demo.gif");
  fs.mkdirSync(path.dirname(mp4), { recursive: true });
  // Trim the blank first frames of page load.
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    "0.6",
    "-i",
    webm,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "24",
    "-movflags",
    "+faststart",
    mp4,
  ]);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    "0.6",
    "-i",
    webm,
    "-vf",
    "fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
    gif,
  ]);
  for (const f of [mp4, gif]) {
    const kb = (fs.statSync(f).size / 1024).toFixed(0);
    console.log(`wrote ${path.relative(ROOT, f)} (${kb} KB)`);
  }
}

async function main() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    throw new Error("dist/index.html is missing — run `npm run build` first.");
  }
  const server = createServer({
    port: PORT,
    host: HOST,
    distDir: DIST,
    libraryDir: path.join(ROOT, "library", "components"),
    allowRemoteWrites: false,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => resolve());
  });
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), "openflume-demo-"));
  try {
    encode(await record(`http://${HOST}:${PORT}/`, videoDir));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(videoDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
