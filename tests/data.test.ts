import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  combineMetrics,
  csv,
  devicesByApp,
  rankApps,
} from "../src/data.ts";
test("app totals sum architectures once and retain missing dates and zeros", () => {
  const plot = devicesByApp(
    {
      first: {
        data: {
          buckets: ["2026-01-01", "2026-01-02"],
          series: [
            { name: "amd64", values: [5, null] },
            { name: "arm64", values: [3, null] },
          ],
        },
      },
      second: {
        data: {
          buckets: ["2026-01-02", "2026-01-03"],
          series: [{ name: "amd64", values: [0, 2] }],
        },
      },
    },
    "2026-01-01",
    "2026-01-03",
  );
  assert.deepEqual(plot.series, [
    { name: "first", values: [8, null, null] },
    { name: "second", values: [null, 0, 2] },
  ]);
  assert.deepEqual(plot.coverage, [1, 1, 1]);
  assert.deepEqual(
    rankApps(plot.series, 1).map((s) => s.name),
    ["first"],
  );
});
test("ranking uses the last available value in range, not an earlier peak", () => {
  const series = [
    { name: "falling", values: [100, 3] },
    { name: "larger", values: [5, null] },
    { name: "empty", values: [null, null] },
  ];
  assert.deepEqual(
    rankApps(series, 20).map((s) => s.name),
    ["larger", "falling", "empty"],
  );
  assert.equal(series[0].name, "falling");
});
test("monthly partitions align categories that appear and disappear", () => {
  assert.deepEqual(
    combineMetrics([
      { buckets: ["2026-01-31"], series: [{ name: "old", values: [4] }] },
      { buckets: ["2026-02-01"], series: [{ name: "new", values: [7] }] },
    ]),
    {
      buckets: ["2026-01-31", "2026-02-01"],
      series: [
        { name: "old", values: [4, null] },
        { name: "new", values: [null, 7] },
      ],
    },
  );
});
test("aggregate aligns dates, preserves gaps, includes zero and reports coverage", () => {
  const result = aggregate(
    [
      {
        data: {
          buckets: ["2026-01-01", "2026-01-02"],
          series: [{ name: "amd64", values: [10, null] }],
        },
      },
      {
        data: {
          buckets: ["2026-01-02", "2026-01-03"],
          series: [{ name: "amd64", values: [0, 20] }],
        },
      },
    ],
    "2026-01-01",
    "2026-01-03",
  );
  assert.deepEqual(result.series[0].values, [10, 0, 20]);
  assert.deepEqual(result.coverage, [1, 1, 1]);
});
test("all-null values remain null, dates are filtered", () => {
  const result = aggregate(
    [
      {
        data: {
          buckets: ["2026-01-01", "2026-01-02"],
          series: [{ name: "a", values: [4, null] }],
        },
      },
    ],
    "2026-01-02",
    "2026-01-02",
  );
  assert.deepEqual(result.series[0].values, [null]);
  assert.deepEqual(result.coverage, [0]);
});
test("CSV preserves missing data and escapes formula-like series names", () => {
  const result = csv({
    dates: ["2026-01-01"],
    coverage: [0],
    series: [{ name: '=bad,"', values: [null] }],
  });
  assert.ok(result.includes('"\'=bad,"""'));
  assert.ok(result.endsWith("2026-01-01,0,"));
});
