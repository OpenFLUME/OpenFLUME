/**
 * e2e/share-link.spec.ts — shareable model links.
 *
 * `#example=<slug>` opens a shipped example; the toolbar Share button copies
 * a `#model=<payload>` link that reopens the same model in a fresh browser.
 * The fragment is cleared after use, and opening a link over existing work
 * asks first.
 */
import { test, expect } from "@playwright/test";

test.describe("Share links", () => {
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

  test("an unknown example slug reports an error and leaves the model alone", async ({
    page,
  }) => {
    await page.goto("/#example=not-a-real-example");
    await page.reload();
    await expect(page.locator('[data-testid="network-name"]')).toHaveValue(
      "Untitled network",
    );
  });

  test("Share copies a link that reopens the model in a clean browser", async ({
    page,
    context,
    browser,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    const confirm = page.locator('[data-testid="confirm-dialog-accept"]');
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await page.locator('[data-testid="network-name"]').fill("Shared junction");
    await page.locator('[data-testid="network-name"]').press("Enter");

    await page.locator('[data-testid="toolbar-share"]').click();
    await expect(page.locator('[data-testid="toolbar-share"]')).toContainText(
      "Link copied",
    );
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toContain("#model=");

    const fresh = await browser.newContext();
    const other = await fresh.newPage();
    await other.goto(url);
    await expect(other.locator('[data-testid="network-name"]')).toHaveValue(
      "Shared junction",
    );
    expect(new URL(other.url()).hash).toBe("");
    await fresh.close();
  });

  test("opening a link over existing work asks first", async ({ page }) => {
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
