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
  await expect(page.locator("#app-picker")).toBeVisible();
  await page.locator("#search").fill("calibre");
  await expect(page.locator(".app-chart-card")).toHaveCount(1);
  await expect(page.locator(".app-chart-card canvas")).toBeVisible();
  await page.locator("#search").fill("*-*");
  await expect(page.locator(".app-chart-card")).toHaveCount(2);
  await page.locator("#search").fill("m?me");
  await expect(page.locator(".app-chart-card")).toHaveCount(1);
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
  await expect(page.locator("#search")).toHaveValue("calibre");
  await expect(page.locator("#chart-title")).toHaveText("Calibre");
  await page.getByRole("link", { name: "Compare apps", exact: true }).click();
  await expect(page.locator("#app-legend button")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("paste app lists and edit the same selection with checkboxes across views", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#coverage")).toHaveText("6 / 6");
  await page.locator("#search").fill(" CALIBRE, mame, halloy,calibre, ");
  await expect(page.locator("#app-legend button")).toHaveCount(3);
  await expect(page.locator("#coverage")).toHaveText("3 / 3");
  await page.locator("#selection-summary").click();
  await expect(page.locator("#snap input:checked")).toHaveCount(3);
  await page.locator('#snap input[value="mame"]').uncheck();
  await page.locator('#snap input[value="ncspot"]').check();
  await expect(page.locator("#search")).toHaveValue("calibre,ncspot,halloy");
  await expect(page.locator("#table thead th")).toHaveCount(5);
  const download = page.waitForEvent("download");
  await page.locator("#export").click();
  const stream = await (await download).createReadStream();
  let csv = "";
  for await (const chunk of stream!) csv += chunk.toString();
  const header = csv.split("\r\n")[0];
  expect(header).toContain('"calibre"');
  expect(header).toContain('"ncspot"');
  expect(header).toContain('"halloy"');
  expect(header).not.toContain('"mame"');
  await page.locator("#dimension").selectOption("architecture");
  await expect(page.locator("#coverage")).toHaveText("3 / 3");
  await expect(
    page.locator('#dimension option[value="version"]'),
  ).toBeDisabled();
  await page.reload();
  await expect(page.locator("#search")).toHaveValue("calibre,ncspot,halloy");
  await expect(page.locator("#coverage")).toHaveText("3 / 3");
  for (const label of ["Compare apps", "All app charts"]) {
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(page.locator("#coverage")).toHaveText("3 / 3");
  }
  await expect(page.locator(".app-chart-card")).toHaveCount(3);
  await page.locator("#selection-summary").click();
  await page.locator("#clear-apps").click();
  await expect(page.locator("#search")).toHaveValue("");
  await expect(page.locator(".app-chart-card")).toHaveCount(6);
  await page.locator('#snap input[value="calibre"]').check();
  await expect(page.locator("#search")).toHaveValue("calibre");
  await expect(page.locator(".app-chart-card")).toHaveCount(1);
  await page.locator('#snap input[value="calibre"]').uncheck();
  await expect(page.locator("#search")).toHaveValue("");
  await expect(page.locator(".app-chart-card")).toHaveCount(6);
  await page.reload();
  await expect(page.locator(".app-chart-card")).toHaveCount(6);
});

test("list bookmarks, unknown names, wildcards and one-app version selection", async ({
  page,
}) => {
  await page.goto("/?search=calibre,mame,unknown&dimension=version");
  await expect(page.locator("#dimension")).toHaveValue("total");
  await expect(page.locator("#coverage")).toHaveText("2 / 2");
  await page.locator("#search").fill("m?me");
  await expect(page.locator("#app-legend button")).toHaveCount(1);
  await page.locator("#dimension").selectOption("version");
  await expect(page.locator("#chart-kicker")).toContainText("Version");
  await page.locator("#search").fill("mame,calibre");
  await expect(page.locator("#dimension")).toHaveValue("total");
  await expect(page.locator("#app-legend button")).toHaveCount(2);
  await page.locator("#search").fill("unknown,missing");
  await expect(page.locator("#coverage")).toHaveText("0 / 0");
  await expect(page.locator("#export")).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#selection-summary").click();
  await page.locator('#snap input[value="calibre"]').check();
  await expect(page.locator("#coverage")).toHaveText("1 / 1");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("the requested three-app list stays exact, including a single picked app", async ({
  page,
}) => {
  await page.route("**/data/**", async (route) => {
    const response = await route.fetch();
    const data = JSON.parse(
      (await response.text())
        .replaceAll("ncspot", "add-flatpak")
        .replaceAll("halloy", "notepadnext"),
    );
    if (data.snaps)
      data.snaps.find((s: { name: string }) => s.name === "mame").title =
        "Calibre companion";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/?view=compare");
  await page.locator("#search").fill("calibre,add-flatpak,notepadnext");
  await expect(page.locator("#app-legend button")).toHaveCount(3);
  await expect(page.locator("#coverage")).toHaveText("3 / 3");
  await page.locator("#selection-summary").click();
  await expect(page.locator('#snap input[value="calibre"]')).toBeChecked();
  await expect(page.locator('#snap input[value="add-flatpak"]')).toBeChecked();
  await expect(page.locator('#snap input[value="notepadnext"]')).toBeChecked();
  await page.screenshot({
    path: "test-results/app-selection-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/app-selection-mobile.png",
    fullPage: true,
  });
  await page.locator("#search").fill("calib");
  await expect(page.locator("#app-legend button")).toHaveCount(2);
  await page.locator('#snap input[value="mame"]').focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#search")).toHaveValue("calibre");
  await expect(page.locator("#app-legend button")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#app-legend button")).toHaveCount(1);
});
