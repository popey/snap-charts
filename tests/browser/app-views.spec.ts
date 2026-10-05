import { test, expect } from "@playwright/test";

test("compare all 55 apps or top 10/20/50, and preserve the selected view", async ({
  page,
}) => {
  await page.route("**/data/**", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const names = Array.from(
      { length: 55 },
      (_, i) => `app-${String(i).padStart(2, "0")}`,
    );
    if (route.request().url().includes("manifest.json")) {
      data.snaps = names.map((name) => ({ name, title: name }));
      for (const metric of data.metrics)
        data.records[metric] = Object.fromEntries(
          names.map((name) => [name, data.records[metric].calibre]),
        );
      await route.fulfill({ response, json: data });
    } else {
      await route.fulfill({
        response,
        json: Object.fromEntries(
          names.map((name, i) => [
            name,
            {
              ...data.calibre,
              series: data.calibre.series.map(
                (s: { name: string; values: (number | null)[] }) => ({
                  ...s,
                  values: s.values.map((v) =>
                    v === null ? null : v * (i + 1),
                  ),
                }),
              ),
            },
          ]),
        ),
      });
    }
  });
  await page.goto("/?view=compare");
  await expect(page.locator("#app-legend button")).toHaveCount(55);
  expect((await page.locator("#chart").boundingBox())!.height).toBe(860);
  await expect(page.locator("#app-count")).toHaveText(
    "Showing 55 of 55 matching apps",
  );
  for (const size of [10, 20, 50]) {
    await page.locator("#rank-limit").selectOption(String(size));
    await expect(page.locator("#app-legend button")).toHaveCount(size);
    await expect(page.locator("#app-legend button").first()).toHaveText(
      "app-54",
    );
  }
  await page.locator("#app-legend button").first().click();
  await expect(page.locator("#app-legend button").first()).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.reload();
  await expect(page.locator("#rank-limit")).toHaveValue("50");
  await expect(page.locator("#app-legend button")).toHaveCount(50);
  await page.screenshot({
    path: "test-results/compare-apps.png",
    fullPage: true,
  });
});

test("gallery shows a chart for every app, supports search and links to breakdowns", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?view=gallery");
  await expect(page.locator(".app-chart-card")).toHaveCount(6);
  await expect(page.locator("#snap")).toBeHidden();
  await page.locator("#search").fill("calibre");
  await expect(page.locator(".app-chart-card")).toHaveCount(1);
  await expect(page.locator(".app-chart-card canvas")).toBeVisible();
  await page.locator("#search").fill("no-such-app");
  await expect(page.locator("#app-charts")).toContainText("No apps match");
  await page.locator("#search").fill("");
  await expect(page.locator(".app-chart-card")).toHaveCount(6);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/app-gallery-mobile.png",
    fullPage: true,
  });
  await page
    .locator(".app-chart-card")
    .filter({ hasText: "calibre" })
    .getByRole("link")
    .click();
  await expect(page.locator("#snap")).toHaveValue("calibre");
  await expect(page.locator("#chart-title")).toHaveText("Calibre");
  await page.getByRole("link", { name: "Compare apps", exact: true }).click();
  await expect(page.locator("#app-legend button")).toHaveCount(6);
  expect(errors).toEqual([]);
});
