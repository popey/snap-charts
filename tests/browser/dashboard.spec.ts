import { test, expect } from "@playwright/test";

test("filters, chart types, data table, CSV and shareable state", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("#notice")).toContainText("DEMO DATA");
  await expect(page.locator("#coverage")).toHaveText("6 / 6");
  const dimensions = await page.locator("#chart").evaluate((e) => ({
    canvas: e.getBoundingClientRect().width,
    parent: e.parentElement!.getBoundingClientRect().width,
  }));
  expect(dimensions.canvas).toBeGreaterThan(dimensions.parent * 0.95);
  expect((await page.locator("#chart").boundingBox())!.height).toBe(860);
  await page.locator("#period").selectOption("7");
  await expect(page.locator("#table tbody tr")).toHaveCount(7);
  await page.locator("#snap").selectOption("calibre");
  await expect(page.locator("#coverage")).toHaveText("1 / 1");
  await page.locator("#dimension").selectOption("operating_system");
  await expect(page.locator("#chart-kicker")).toContainText("Operating system");
  await page.locator("#window").selectOption("daily");
  await expect(page.locator("#chart-kicker")).toContainText("Daily");
  await page.locator("#chart-type").selectOption("bar");
  await page.locator("#period").selectOption("90");
  await page.locator("summary").click();
  await expect(page.locator("#table tbody tr")).toHaveCount(90);
  await page.locator("#series").selectOption("Ubuntu/24.04");
  await expect(page.locator("#table thead th")).toHaveCount(3);
  const download = page.waitForEvent("download");
  await page.locator("#export").click();
  expect((await download).suggestedFilename()).toContain(
    "calibre-installed_base_by_operating_system",
  );
  await page.reload();
  await expect(page.locator("#snap")).toHaveValue("calibre");
  await expect(page.locator("#table tbody tr")).toHaveCount(90);
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("mobile stays within viewport and empty dates do not show zero", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#coverage")).toHaveText("6 / 6");
  expect((await page.locator("#chart").boundingBox())!.height).toBe(720);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  await page.locator("#start").fill("2010-01-01");
  await page.locator("#end").fill("2010-01-02");
  await page.locator("#end").blur();
  await expect(page.locator("#total")).toHaveText("—");
  await expect(page.locator("#chart-status")).toContainText("No data");
  await expect(page.locator("#export")).toBeDisabled();
});

test("missing manifest produces a useful setup state", async ({ page }) => {
  await page.route("**/data/manifest.json", (route) =>
    route.fulfill({ status: 404, body: "Missing" }),
  );
  await page.goto("/");
  await expect(page.locator("#chart-status")).toContainText(
    "No metrics collected yet",
  );
  await expect(page.locator("#export")).toBeDisabled();
});
