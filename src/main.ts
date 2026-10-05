import "./style.scss";
import Chart from "chart.js/auto";
import {
  aggregate,
  devicesByApp,
  rankApps,
  combineMetrics,
  csv,
  type Metric,
  type RecordData,
  type Plot,
} from "./data";

import { clearAppCharts, renderAppCharts } from "./app-charts";

type View = "metrics" | "compare" | "gallery";
let view: View = "metrics";

type Manifest = {
  generatedAt: string;
  demo: boolean;
  historyStart: string;
  snaps: { name: string; title: string }[];
  metrics: string[];
  records: Record<string, Record<string, RecordData>>;
  partitions: Record<string, string[]>;
};
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const number = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("en-GB", { maximumFractionDigits: 1 });
const dimensions = [
  ["architecture", "Architecture"],
  ["channel", "Channel"],
  ["operating_system", "Operating system"],
  ["country", "Country"],
  ["version", "Version"],
  ["change", "Device change"],
];
const options = (items: string[][]) =>
  items.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
let manifest: Manifest,
  records: Record<string, RecordData> = {},
  chart: Chart | undefined,
  latest: Plot;
let requestId = 0;
const cache = new Map<string, Record<string, Metric>>();
let loading = false;

$("app").innerHTML = `
<a class="skip" href="#main">Skip to charts</a>
<header id="navigation" class="p-navigation is-dark"><div class="p-navigation__row--25-75">
  <div class="p-navigation__banner"><div class="p-navigation__tagged-logo"><a class="p-navigation__link" href="/"><span class="p-navigation__logo-title">Snap Metrics</span></a></div></div>
  <nav class="p-navigation__nav" aria-label="Main"><ul class="p-navigation__items"><li class="p-navigation__item is-selected"><a class="p-navigation__link" href="?view=metrics" data-view="metrics">Breakdowns</a></li><li class="p-navigation__item"><a class="p-navigation__link" href="?view=compare" data-view="compare">Compare apps</a></li><li class="p-navigation__item"><a class="p-navigation__link" href="?view=gallery" data-view="gallery">All app charts</a></li><li class="p-navigation__item"><a class="p-navigation__link" href="https://snaps.popey.com">Snap Status ↗</a></li></ul><ul class="p-navigation__items"><li class="p-navigation__item"><a class="p-navigation__link" href="https://github.com/popey/snap-charts">GitHub ↗</a></li></ul></nav>
</div></header>
<div class="status-strip"><div class="shell" id="sync">Loading metrics…</div></div>
<main id="main" class="shell">
  <h1 class="u-off-screen">Snap Metrics</h1>
  <p id="notice" role="status"></p>
  <section class="controls" aria-label="Chart filters">
    <div><label for="search">Find an app</label><input id="search" type="search" placeholder="Filter snap names…"></div>
    <div><label for="snap">Application</label><select id="snap"><option value="all">All maintained snaps</option></select></div>
    <div><label for="dimension">Breakdown</label><select id="dimension">${options(dimensions)}</select></div>
    <div><label for="window">Store metric</label><select id="window">${options([
      ["weekly", "Seven-day window"],
      ["daily", "Daily"],
    ])}</select></div>
    <div><label for="period">Period</label><select id="period">${options([
      ["7", "Last 7 days"],
      ["30", "Last 30 days"],
      ["90", "Last 90 days"],
      ["365", "Last year"],
      ["all", "All history"],
      ["custom", "Custom dates"],
    ])}</select></div>
    <div><label for="start">From</label><input type="date" id="start"></div>
    <div><label for="end">Through</label><input type="date" id="end" value="${yesterday}" max="${yesterday}"></div>
    <div><label for="chart-type">Chart style</label><select id="chart-type">${options(
      [
        ["line", "Lines"],
        ["bar", "Stacked bars"],
      ],
    )}</select></div>
  </section>
  <div class="summary"><div><span id="total-label">Latest installations</span><strong id="total">—</strong><small id="total-date"></small></div><div><span>Change over selected period</span><strong id="change">—</strong><small>Latest minus first available day</small></div><div><span>Snaps with data on latest day</span><strong id="coverage">—</strong><small id="history"></small></div></div>
  <section class="chart-panel"><div class="chart-heading"><div><p class="kicker" id="chart-kicker">INSTALLATION TRENDS</p><h2 id="chart-title" class="p-heading--3">All maintained snaps</h2></div><button id="export" class="p-button" disabled>Download CSV ↓</button></div>
    <p id="description"></p><div id="series-control"><label for="series">Series to display</label><select id="series"><option value="">Top 10 by latest value</option></select></div><div id="rank-control" hidden><label for="rank-limit">Apps to display</label><select id="rank-limit"><option value="all">All apps</option><option value="10">Top 10</option><option value="20">Top 20</option><option value="50">Top 50</option></select><p id="app-count" class="muted"></p></div><p id="chart-status" role="status">Loading…</p><div class="canvas-wrap"><canvas id="chart" role="img" aria-label="Installation trends. Exact values are available in the data table below."></canvas></div>
    <div id="app-legend" class="app-legend"></div><div id="app-charts" class="app-charts"></div><p class="chart-hint">Hover or tap for values. Select a legend label to hide a series.</p>
  </section>
  <details><summary>Explore the numbers <span class="muted">· accessible data table</span></summary><div class="table-scroll" id="table"></div></details>
  <section class="notes"><h2 class="p-heading--4">Reading these charts</h2><p>Totals across apps count snap installations, not unique devices. A device with two snaps contributes twice. Breakdowns are separate Store metrics; they cannot be cross-filtered. Gaps mean unavailable data, not zero. Aggregate figures include only available data; changing coverage can affect trends.</p><p>Seven-day installed-base metrics are rolling averages, as supplied by the Store. Device change shows new, continued and lost devices; seven-day device change compares consecutive windows. Installed-base counts are snapshots and are never summed over time.</p></section>
</main><footer class="shell">A personal dashboard by popey. Built with Canonical Vanilla Framework.<br><a href="https://ubuntu.com/docs/snapcraft/latest/reference/metrics/">About Snap Store metrics ↗</a></footer>`;

$<HTMLSelectElement>("period").value = "30";

function metricName() {
  const dim =
      view === "metrics"
        ? $<HTMLSelectElement>("dimension").value
        : "architecture",
    weekly = $<HTMLSelectElement>("window").value === "weekly";
  return dim === "change"
    ? `${weekly ? "weekly" : "daily"}_device_change`
    : `${weekly ? "weekly_" : ""}installed_base_by_${dim}`;
}
function setDates() {
  const period = $<HTMLSelectElement>("period").value;
  if (period === "custom") return;
  $<HTMLInputElement>("end").value = yesterday;
  $<HTMLInputElement>("start").value =
    period === "all"
      ? manifest.historyStart
      : new Date(Date.parse(yesterday) - (Number(period) - 1) * 86400000)
          .toISOString()
          .slice(0, 10);
}
function populateSnaps() {
  const select = $<HTMLSelectElement>("snap"),
    chosen = select.value,
    query = $<HTMLInputElement>("search").value.toLowerCase();
  select.innerHTML =
    '<option value="all">All maintained snaps</option>' +
    manifest.snaps
      .filter(
        (s) =>
          `${s.name} ${s.title}`.toLowerCase().includes(query) ||
          s.name === chosen,
      )
      .map(
        (s) =>
          `<option value="${escape(s.name)}">${escape(s.title)} (${escape(s.name)})</option>`,
      )
      .join("");
  select.value = chosen;
}
async function loadMetric() {
  if (!manifest) return;
  const id = ++requestId,
    key = metricName();
  loading = true;
  $("chart-status").textContent = "Loading metric…";
  $<HTMLButtonElement>("export").disabled = true;
  try {
    const start = $<HTMLInputElement>("start").value.slice(0, 7),
      end = $<HTMLInputElement>("end").value.slice(0, 7);
    const months = manifest.partitions[key].filter(
      (m) => m >= start && m <= end,
    );
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, months.length) }, async () => {
        while (next < months.length && id === requestId) {
          const file = `${key}/${months[next++]}`;
          if (!cache.has(file)) {
            const response = await fetch(
              `/data/${file}.json?v=${encodeURIComponent(manifest.generatedAt)}`,
            );
            if (!response.ok)
              throw new Error("Metric file could not be loaded.");
            cache.set(file, await response.json());
          }
        }
      }),
    );
    if (id !== requestId) return;
    records = Object.fromEntries(
      manifest.snaps.map((s) => [
        s.name,
        {
          ...manifest.records[key][s.name],
          data: combineMetrics(
            months
              .map((m) => cache.get(`${key}/${m}`)![s.name])
              .filter(Boolean),
          ),
        },
      ]),
    );
    loading = false;
    draw();
  } catch (e) {
    if (id === requestId) {
      loading = false;
      records = {};
      chart?.destroy();
      chart = undefined;
      clearAppCharts();
      $("chart-status").textContent = `${e} Reload the page to retry.`;
      $("table").textContent = "";
      for (const key of ["total", "change", "coverage"])
        $(key).textContent = "—";
    }
  }
}
function draw() {
  if (!manifest || loading) return;
  const selected =
    view === "metrics" ? $<HTMLSelectElement>("snap").value : "all";
  const query = $<HTMLInputElement>("search").value.toLowerCase();
  const names =
    selected === "all"
      ? manifest.snaps
          .filter(
            (s) =>
              view === "metrics" ||
              `${s.name} ${s.title}`.toLowerCase().includes(query),
          )
          .map((s) => s.name)
      : [selected];
  const chosen = names.map((n) => records[n] ?? {});
  const start = $<HTMLInputElement>("start").value,
    end = $<HTMLInputElement>("end").value;
  chart?.destroy();
  chart = undefined;
  clearAppCharts();
  if (!start || !end || start > end || end > yesterday) {
    $("chart-status").textContent =
      "Choose a valid date range ending no later than yesterday.";
    $<HTMLButtonElement>("export").disabled = true;
    $("table").textContent = "";
    for (const id of ["total", "change", "coverage"]) $(id).textContent = "—";
    return;
  }
  latest =
    view === "metrics"
      ? aggregate(chosen, start, end)
      : devicesByApp(
          Object.fromEntries(names.map((n) => [n, records[n] ?? {}])),
          start,
          end,
        );
  const isChange =
    view === "metrics" && $<HTMLSelectElement>("dimension").value === "change";
  $("chart-title").textContent =
    view === "compare"
      ? "Devices per app"
      : view === "gallery"
        ? "All app charts"
        : selected === "all"
          ? "All maintained snaps"
          : manifest.snaps.find((s) => s.name === selected)!.title;
  $("chart-kicker").textContent =
    `${view === "metrics" ? $<HTMLSelectElement>("dimension").selectedOptions[0].text : "Devices per app"} · ${$<HTMLSelectElement>("window").selectedOptions[0].text}`;
  const errors = chosen.filter((r) => r.error).length,
    pending = chosen.filter(
      (r) => !r.historyFrom || r.historyFrom > manifest.historyStart,
    ).length;
  const stale = chosen.filter(
    (r) => !r.updatedAt || Date.now() - Date.parse(r.updatedAt) > 2 * 86400000,
  ).length;
  $("chart-status").textContent = [
    latest.dates.length ? "" : "No data is available for this selection.",
    errors
      ? `${errors} metric queries failed; showing retained data where available.`
      : "",
    stale ? `${stale} snaps have stale or uncollected metrics.` : "",
    pending ? `${pending} snaps still have history to backfill.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  $("history").textContent = pending
    ? "Historical backfill in progress"
    : "Historical collection complete";
  const indices = latest.dates
      .map((_, i) => i)
      .filter((i) => latest.coverage[i] > 0),
    first = indices[0],
    last = indices.at(-1);
  const totalAt = (i: number | undefined) =>
    i === undefined
      ? null
      : latest.series.reduce((n, s) => n + (s.values[i] ?? 0), 0);
  const total = totalAt(last),
    initial = totalAt(first);
  if (last !== undefined && latest.coverage[last] < names.length) {
    $("chart-status").textContent +=
      ` Only ${latest.coverage[last]} of ${names.length} snaps report data for ${latest.dates[last]}; the latest totals are partial.`;
  }
  $("total-label").textContent = isChange
    ? "Device change categories"
    : "Latest installations";
  $("total").textContent = isChange ? "See chart" : number(total);
  $("total-date").textContent =
    last === undefined ? "No observations" : latest.dates[last];
  $("change").textContent =
    isChange || total === null || initial === null
      ? "—"
      : `${total - initial > 0 ? "+" : ""}${number(total - initial)}`;
  $("coverage").textContent =
    `${last === undefined ? 0 : latest.coverage[last]} / ${names.length}`;
  $("description").textContent = isChange
    ? "New, continued and lost devices. Lost devices are shown as positive counts."
    : "Installed base over time. Values are shown exactly as supplied by the Snap Store.";
  if (view !== "metrics") {
    const limit = $<HTMLSelectElement>("rank-limit").value;
    const visible = rankApps(
      latest.series,
      limit === "all" ? Infinity : Number(limit),
    );
    $("description").textContent =
      "One total per app, summed across architectures. Ranked by each app’s latest available observation in the selected period. " +
      (view === "gallery"
        ? "Each chart uses its own vertical scale."
        : "Hover or tap a line for its device count; use the legend to hide apps.");
    $("app-count").textContent =
      `Showing ${visible.length} of ${names.length} matching apps`;
    $("total-label").textContent = "Latest installations (all matching apps)";
    finishDraw(visible, selected, start, end);
    renderAppCharts(
      latest,
      visible,
      view === "gallery",
      new Map(manifest.snaps.map((s) => [s.name, s.title])),
    );
    return;
  }
  const colors = [
    "#e95420",
    "#006d77",
    "#77216f",
    "#2b6cb0",
    "#7b6310",
    "#a52745",
    "#3d7a38",
    "#684cb6",
    "#666666",
  ];
  latest.series.sort(
    (a, b) => (b.values[last ?? 0] ?? 0) - (a.values[last ?? 0] ?? 0),
  );
  const selector = $<HTMLSelectElement>("series"),
    previous = selector.value;
  selector.innerHTML =
    '<option value="">Top 10 by latest value</option>' +
    latest.series
      .map(
        (s) => `<option value="${escape(s.name)}">${escape(s.name)}</option>`,
      )
      .join("");
  if (latest.series.some((s) => s.name === previous)) selector.value = previous;
  const visible = selector.value
    ? latest.series.filter((s) => s.name === selector.value)
    : latest.series.slice(0, 10);
  const bar = $<HTMLSelectElement>("chart-type").value === "bar";
  chart = new Chart($<HTMLCanvasElement>("chart"), {
    type: bar ? "bar" : "line",
    data: {
      labels: latest.dates,
      datasets: visible.map((s, i) => ({
        label: s.name,
        data: s.values,
        borderColor: colors[i % colors.length],
        backgroundColor: colors[i % colors.length] + (bar ? "bb" : "20"),
        borderWidth: 2,
        pointRadius: 0,
        pointHitRadius: 8,
        spanGaps: false,
        hidden: i >= 10,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            afterTitle: (items) =>
              `${latest.coverage[items[0].dataIndex]} of ${names.length} snaps reporting`,
          },
        },
      },
      scales: {
        x: {
          stacked: bar,
          ticks: { maxTicksLimit: 9, maxRotation: 0 },
          grid: { display: false },
        },
        y: {
          stacked: bar,
          beginAtZero: true,
          title: {
            display: true,
            text: isChange ? "Devices" : "Snap installations",
          },
        },
      },
    },
  });
  if (latest.series.length > 10)
    $("chart-status").textContent +=
      " Showing the selected series or top 10. Choose any other series above. CSV includes every series.";
  finishDraw(visible, selected, start, end);
}
function finishDraw(
  visible: Plot["series"],
  selected: string,
  start: string,
  end: string,
) {
  $<HTMLButtonElement>("export").disabled = !latest.dates.length;
  $("table").innerHTML =
    `<table><caption>Selected series, latest 100 dates in range; — means unavailable. Download CSV for every date and series.</caption><thead><tr><th>Date</th><th>Snaps with data</th>${visible.map((s) => `<th>${escape(s.name)}</th>`).join("")}</tr></thead><tbody>${latest.dates
      .map((d, i) => ({ d, i }))
      .slice(-100)
      .map(
        ({ d, i }) =>
          `<tr><th>${d}</th><td>${latest.coverage[i]}</td>${visible.map((s) => `<td>${number(s.values[i])}</td>`).join("")}</tr>`,
      )
      .join("")}</tbody></table>`;
  const params = new URLSearchParams({
    view,
    top: $<HTMLSelectElement>("rank-limit").value,
    search: view === "metrics" ? "" : $<HTMLInputElement>("search").value,
    snap: selected,
    dimension: $<HTMLSelectElement>("dimension").value,
    window: $<HTMLSelectElement>("window").value,
    start,
    end,
  });
  history.replaceState(null, "", `?${params}`);
}
$("export").addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([csv(latest)], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `snap-charts-${view === "metrics" ? $<HTMLSelectElement>("snap").value : "apps"}-${metricName()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const id of ["dimension", "window"])
  $(id).addEventListener("change", loadMetric);
for (const id of ["snap", "chart-type", "series", "rank-limit"])
  $(id).addEventListener("change", draw);
for (const id of ["start", "end"])
  $(id).addEventListener("change", () => {
    $<HTMLSelectElement>("period").value = "custom";
    void loadMetric();
  });
$("period").addEventListener("change", () => {
  setDates();
  void loadMetric();
});
$("search").addEventListener("input", () => {
  if (manifest) {
    populateSnaps();
    if (view !== "metrics") draw();
  }
});
function updateView() {
  for (const id of ["snap", "dimension", "chart-type"])
    $(id).parentElement!.hidden = view !== "metrics";
  $("series-control").hidden = view !== "metrics";
  $("rank-control").hidden = view === "metrics";
  $("chart").parentElement!.hidden = view === "gallery";
  $("app-legend").hidden = view !== "compare";
  $("app-charts").hidden = view !== "gallery";
  document
    .querySelectorAll<HTMLAnchorElement>("[data-view]")
    .forEach((link) => {
      link.parentElement!.classList.toggle(
        "is-selected",
        link.dataset.view === view,
      );
      if (link.dataset.view === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
}
document.querySelectorAll<HTMLAnchorElement>("[data-view]").forEach((link) =>
  link.addEventListener("click", (event) => {
    event.preventDefault();
    view = link.dataset.view as View;
    updateView();
    void loadMetric();
  }),
);
async function init() {
  const response = await fetch("/data/manifest.json", { cache: "no-store" });
  if (!response.ok)
    throw new Error(
      "No metrics collected yet. Run the collector, or run npm run demo for a labelled local preview.",
    );
  manifest = await response.json();
  populateSnaps();
  setDates();
  const params = new URLSearchParams(location.search);
  const requestedView = params.get("view");
  if (requestedView === "compare" || requestedView === "gallery")
    view = requestedView;
  const top = params.get("top");
  if (top && ["all", "10", "20", "50"].includes(top))
    $<HTMLSelectElement>("rank-limit").value = top;
  $<HTMLInputElement>("search").value = params.get("search") ?? "";
  updateView();
  for (const id of ["snap", "dimension", "window"]) {
    const el = $<HTMLSelectElement>(id),
      value = params.get(id);
    if (value && [...el.options].some((o) => o.value === value))
      el.value = value;
  }
  for (const id of ["start", "end"]) {
    const value = params.get(id);
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      $<HTMLInputElement>(id).value = value;
      $<HTMLSelectElement>("period").value = "custom";
    }
  }
  $("sync").textContent =
    `${manifest.snaps.length} snaps tracked · Updated daily · Collected ${new Date(manifest.generatedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC`;
  $("notice").textContent = manifest.demo
    ? "DEMO DATA — synthetic figures for previewing the dashboard. These are not your Store metrics."
    : Date.now() - Date.parse(manifest.generatedAt) > 2 * 86400000
      ? "Collection is more than 48 hours old. The daily refresh may need attention."
      : "";
  await loadMetric();
}
init().catch((e) => {
  $("chart-status").textContent = e.message;
  $("sync").textContent = "Awaiting first collection";
  document
    .querySelectorAll("input,select,button")
    .forEach((e) => ((e as HTMLInputElement).disabled = true));
});
