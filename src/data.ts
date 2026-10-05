export type Metric = {
  buckets: string[];
  series: { name: string; values: (number | null)[] }[];
};
export type RecordData = {
  data?: Metric;
  updatedAt?: string;
  error?: string;
  historyFrom?: string;
};
export type Plot = {
  dates: string[];
  series: { name: string; values: (number | null)[] }[];
  coverage: number[];
};
export function devicesByApp(
  records: Record<string, RecordData>,
  start: string,
  end: string,
): Plot {
  const dates = [
    ...new Set(Object.values(records).flatMap((r) => r.data?.buckets ?? [])),
  ]
    .filter((d) => d >= start && d <= end)
    .sort();
  const series = Object.entries(records).map(([name, record]) => {
    const totals = new Map(
      record.data?.buckets.map((day, i) => {
        const values = record
          .data!.series.map((s) => s.values[i])
          .filter((v): v is number => v != null);
        return [day, values.length ? values.reduce((a, b) => a + b, 0) : null];
      }),
    );
    return { name, values: dates.map((day) => totals.get(day) ?? null) };
  });
  return {
    dates,
    series,
    coverage: dates.map(
      (_, i) => series.filter((s) => s.values[i] != null).length,
    ),
  };
}

export function rankApps(
  series: Plot["series"],
  limit: number,
): Plot["series"] {
  const last = (s: Plot["series"][number]) =>
    s.values.findLast((v) => v !== null) ?? -1;
  return [...series]
    .sort((a, b) => last(b) - last(a) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
export function combineMetrics(parts: Metric[]): Metric {
  const buckets = parts.flatMap((p) => p.buckets);
  const names = [...new Set(parts.flatMap((p) => p.series.map((s) => s.name)))];
  const maps = parts.map(
    (p) => new Map(p.series.map((s) => [s.name, s.values])),
  );
  return {
    buckets,
    series: names.map((name) => ({
      name,
      values: parts.flatMap(
        (p, i) => maps[i].get(name) ?? p.buckets.map(() => null),
      ),
    })),
  };
}
export function aggregate(
  records: RecordData[],
  start: string,
  end: string,
): Plot {
  const dates = [...new Set(records.flatMap((r) => r.data?.buckets ?? []))]
    .filter((d) => d >= start && d <= end)
    .sort();
  const names = [
    ...new Set(records.flatMap((r) => r.data?.series.map((s) => s.name) ?? [])),
  ].sort();
  const maps = records.map(
    (r) => new Map(r.data?.buckets.map((d, i) => [d, i])),
  );
  const seriesMaps = records.map(
    (r) => new Map(r.data?.series.map((s) => [s.name, s.values])),
  );
  const coverage = dates.map(
    (d) =>
      records.filter((r, j) => {
        const i = maps[j].get(d);
        return (
          i !== undefined && r.data?.series.some((s) => s.values[i] != null)
        );
      }).length,
  );
  return {
    dates,
    coverage,
    series: names.map((name) => ({
      name,
      values: dates.map((d) => {
        let total = 0,
          seen = false;
        records.forEach((r, j) => {
          const i = maps[j].get(d),
            values = seriesMaps[j].get(name);
          const value = i === undefined ? null : values?.[i];
          if (value != null) {
            total += value;
            seen = true;
          }
        });
        return seen ? total : null;
      }),
    })),
  };
}
export function csv(plot: Plot): string {
  const quote = (v: string) =>
    `"${(/^[=+@\-\t\r]/.test(v) ? "'" : "") + v.replaceAll('"', '""')}"`;
  return [
    ["Date", "Snaps with data", ...plot.series.map((s) => s.name)]
      .map(quote)
      .join(","),
    ...plot.dates.map((d, i) =>
      [d, plot.coverage[i], ...plot.series.map((s) => s.values[i] ?? "")].join(
        ",",
      ),
    ),
  ].join("\r\n");
}
