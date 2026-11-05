/**
 * e2e/example-link.spec.ts — `#example=<slug>` deep links open a shipped
 * example, clear the fragment, and ask before replacing existing work.
 */
import { test, expect } from "@playwright/test";

test.describe("Example links", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
  });

  test("an example link opens the example and clears the fragment", async ({
    page,
  }) => {
    await page.goto("/#example=tank-blowdown");
    await page.reload();
    await expect(page.locator('[data-testid="network-name"]')).toHaveValue(
      /blowdown/i,
    );
    expect(new URL(page.url()).hash).toBe("");
  });

  test("an unknown example slug leaves the model alone", async ({ page }) => {
    await page.goto("/#example=not-a-real-example");
    await page.reload();
    await expect(page.locator('[data-testid="network-name"]')).toHaveValue(
      "Untitled network",
    );
  });

  test("opening an example link over existing work asks first", async ({
    page,
  }) => {
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.goto("/#example=tank-blowdown");
    await page.reload();
    const accept = page.locator('[data-testid="confirm-dialog-accept"]');
    await expect(accept).toBeVisible();
    await accept.click();
    await expect(page.locator('[data-testid="network-name"]')).toHaveValue(
      /blowdown/i,
    );
  });
});
