import Chart from "chart.js/auto";
import type { Plot } from "./data";

let charts: Chart[] = [];
export function clearAppCharts() {
  charts.forEach((chart) => chart.destroy());
  charts = [];
  document.getElementById("app-charts")!.replaceChildren();
  document.getElementById("app-legend")!.replaceChildren();
}

export function renderAppCharts(
  plot: Plot,
  visible: Plot["series"],
  gallery: boolean,
  titles: Map<string, string>,
) {
  clearAppCharts();
  const root = document.getElementById("app-charts")!;
  const canvas = document.getElementById("chart") as HTMLCanvasElement;
  const color = (i: number) => `hsl(${(i * 137.508 + 15) % 360} 65% 38%)`;
  if (!visible.length) {
    root.textContent = "No apps match this search.";
    return;
  }
  const makeChart = (
    canvas: HTMLCanvasElement,
    series: Plot["series"],
    small: boolean,
  ) => {
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: plot.dates,
        datasets: series.map((s, i) => ({
          label: s.name,
          data: s.values,
          borderColor: color(i),
          backgroundColor: color(i),
          borderWidth: 2,
          pointRadius: 0,
          pointHitRadius: 8,
          spanGaps: false,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          mode: small ? "index" : "nearest",
          axis: "xy",
          intersect: false,
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) =>
                `${item.dataset.label}: ${item.parsed.y?.toLocaleString("en-GB")} devices`,
            },
          },
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: small ? 4 : 9, maxRotation: 0 },
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            title: { display: !small, text: "Devices per app" },
          },
        },
      },
    });
    charts.push(chart);
    return chart;
  };
  if (!gallery) {
    const chart = makeChart(canvas, visible, false);
    const legend = document.getElementById("app-legend")!;
    visible.forEach((series, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "app-legend-item";
      button.textContent = series.name;
      button.style.borderLeftColor = color(i);
      button.setAttribute("aria-pressed", "true");
      button.addEventListener("click", () => {
        const show = !chart.isDatasetVisible(i);
        chart.setDatasetVisibility(i, show);
        button.setAttribute("aria-pressed", String(show));
        chart.update();
      });
      legend.append(button);
    });
    return;
  }
  for (const series of visible) {
    const card = document.createElement("article");
    card.className = "app-chart-card";
    const heading = document.createElement("h3");
    heading.className = "p-heading--4";
    heading.textContent = titles.get(series.name) ?? series.name;
    const name = document.createElement("p");
    name.className = "app-chart-name";
    name.textContent = series.name;
    const latest = series.values.findLastIndex((value) => value !== null);
    const summary = document.createElement("p");
    summary.className = "app-chart-value";
    summary.textContent =
      latest < 0
        ? "No observations in this period"
        : `${series.values[latest]!.toLocaleString("en-GB")} devices · ${plot.dates[latest]}`;
    const wrapper = document.createElement("div");
    wrapper.className = "app-chart-canvas";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      `Devices with ${series.name} installed over the selected period. Exact values are in the data table or CSV.`,
    );
    wrapper.append(canvas);
    const link = document.createElement("a");
    const params = new URLSearchParams(location.search);
    params.set("view", "metrics");
    params.set("snap", series.name);
    params.set("dimension", "architecture");
    link.href = `?${params}`;
    link.textContent = "Explore breakdowns →";
    card.append(heading, name, summary, wrapper, link);
    root.append(card);
    makeChart(canvas, [series], true);
  }
}
