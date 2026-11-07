/**
 * e2e/embed-mode.spec.ts — read-only embed mode (issue #26):
 * `?embed=1` loads an example, shows "Open in full editor", hides the
 * outline/inspector chrome, and never writes to localStorage.
 */
import { test, expect } from "@playwright/test";

test.describe("Embed mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
  });

  test("an embed link loads the example, shows the full-editor link, and leaves localStorage alone", async ({
    page,
  }) => {
    await page.goto("/?embed=1#example=tank-blowdown");
    await page.reload();

    await expect(page.locator('[data-testid="network-name"]')).toHaveValue(
      /blowdown/i,
    );
    const link = page.locator('[data-testid="embed-open-full-editor"]');
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).not.toContain("embed=");
    // editing chrome is hidden, the toolbar Run stays
    await expect(page.locator('[data-testid="studio-outline"]')).toBeHidden();
    await expect(
      page.locator('[data-testid="toolbar-run"]'),
    ).toBeVisible();
    // the embed wrote nothing: the visitor's autosave stays untouched
    const stored = await page.evaluate(() =>
      Object.entries(localStorage),
    );
    expect(
      stored.filter(([key]) => key.includes("fluids-network")),
    ).toEqual([]);
  });

  test("without ?embed=1 there is no full-editor link", async ({ page }) => {
    await page.goto("/");
    await page.reload();
    await expect(
      page.locator('[data-testid="embed-open-full-editor"]'),
    ).toHaveCount(0);
  });
});
