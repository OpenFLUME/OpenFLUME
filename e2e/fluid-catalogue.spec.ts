/**
 * e2e/fluid-catalogue.spec.ts — the real-fluid picker backed by the generated
 * CoolProp HEOS catalogue: all 124 fluids discoverable, curated favorites
 * first, search filtering, ⚠ markers for no-transport fluids, and a saved
 * unknown fluid rendered as visibly invalid instead of silently reverting.
 */
import { test, expect } from "@playwright/test";

const CATALOGUE_COUNT = 124;

async function openFluidsTab(page: import("@playwright/test").Page) {
  await page.locator('[data-testid="config-tab"]').click();
  await expect(
    page.locator('[data-testid="configuration-view"]'),
  ).toBeVisible();
  // The dialog opens on Solver; the fluid roster is its own section.
  await page.locator('[data-testid="settings-tab-fluids"]').click();
  await expect(
    page.locator('[data-testid="settings-tab-panel-fluids"]'),
  ).toBeVisible();
}

async function openRealFluidSettings(page: import("@playwright/test").Page) {
  await page.goto("/");
  await openFluidsTab(page);
  await page
    .locator('[data-testid="settings-fluid-model"]')
    .selectOption("realFluid");
  await expect(
    page.locator('[data-testid="settings-real-fluid-name"]'),
  ).toBeVisible();
}

test("fluid picker lists favorites plus all HEOS catalogue fluids", async ({
  page,
}) => {
  await openRealFluidSettings(page);

  const select = page.locator('[data-testid="settings-real-fluid-name"]');
  // Favorites optgroup first, then the full catalogue.
  await expect(select.locator("optgroup").first()).toHaveAttribute(
    "label",
    "Favorites",
  );
  await expect(select.locator("optgroup").nth(1)).toHaveAttribute(
    "label",
    `All CoolProp HEOS fluids (${CATALOGUE_COUNT})`,
  );
  // One option per catalogue fluid in the All group.
  await expect(select.locator("optgroup").nth(1).locator("option")).toHaveCount(
    CATALOGUE_COUNT,
  );
  // Spot-check fluids that were outside the old 9-item allowlist.
  await expect(select.locator('option[value="R134a"]')).toHaveCount(1);
  await expect(select.locator('option[value="OrthoHydrogen"]')).toHaveCount(1);
  await expect(select.locator('option[value="Air"]')).toHaveCount(1);

  // Native select behavior is retained: selectOption by canonical value works.
  await select.selectOption("R134a");
  await expect(select).toHaveValue("R134a");
});

test("fluid picker search filters by name and alias", async ({ page }) => {
  await openRealFluidSettings(page);
  const select = page.locator('[data-testid="settings-real-fluid-name"]');
  const search = page.locator('[data-testid="settings-real-fluid-search"]');

  await search.fill("R134");
  await expect(select.locator('option[value="R134a"]')).toHaveCount(1);
  await expect(select.locator('option[value="Nitrogen"]')).toHaveCount(0);

  // Alias match: "N2" finds Nitrogen — in the Favorites group AND the All
  // group (a favorite that matches the filter appears in both).
  await search.fill("N2");
  await expect(select.locator('option[value="Nitrogen"]')).toHaveCount(2);
  await expect(select.locator('option[value="R134a"]')).toHaveCount(0);

  // Clearing the search restores the full catalogue.
  await search.fill("");
  await expect(select.locator("optgroup").nth(1).locator("option")).toHaveCount(
    CATALOGUE_COUNT,
  );
});

test("no-transport fluids are marked and flagged invalid when selected", async ({
  page,
}) => {
  await openRealFluidSettings(page);
  const select = page.locator('[data-testid="settings-real-fluid-name"]');

  // Marker text in the option label keeps the fluid discoverable.
  await expect(select.locator('option[value="OrthoHydrogen"]')).toContainText(
    "no transport model",
  );

  await select.selectOption("OrthoHydrogen");
  await expect(select).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.locator('[data-testid="configuration-view"]'),
  ).toContainText("has no viscosity or thermal-conductivity model");
});

test("a saved unknown fluid renders as a visible invalid value", async ({
  page,
}) => {
  await page.goto("/");
  // Inject a config whose fluid name is not in the catalogue (raw config JSON
  // under the autosave key, same pattern as network.spec.ts).
  await page.evaluate(() => {
    const config = {
      meta: { name: "unknown-fluid", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "realFluid", params: { fluidName: "Unobtanium" } },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "A",
          to: "B",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.01,
            roughness: 1e-5,
          },
        },
      ],
    };
    window.localStorage.setItem(
      "fluids-network-config-v1",
      JSON.stringify(config),
    );
  });
  await page.reload();

  await openFluidsTab(page);

  const select = page.locator('[data-testid="settings-real-fluid-name"]');
  await expect(select).toHaveValue("Unobtanium");
  await expect(select).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.locator('[data-testid="configuration-view"]'),
  ).toContainText("⚠ Unknown fluid: Unobtanium");

  // Picking a real fluid clears the invalid state.
  await select.selectOption("Nitrogen");
  await expect(select).toHaveValue("Nitrogen");
  await expect(select).not.toHaveAttribute("aria-invalid", "true");
});
