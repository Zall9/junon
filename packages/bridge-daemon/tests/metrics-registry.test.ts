import { describe, expect, it } from "vitest";

import { MetricsRegistry } from "../src/observability/metrics-registry.js";

/**
 * The counters a dashboard would read, and the bounds that keep them from becoming a log.
 *
 * The point of these is not that addition works. It is that the registry cannot grow with traffic — the
 * failure mode of "just add metrics" is a daemon whose memory tracks how much it has been used — and that
 * the one place it keeps user text keeps a bounded, forgettable amount of it (ADR-0035).
 */
describe("MetricsRegistry", () => {
  it("counts calls per method and estimates latency from a bounded reservoir", () => {
    const metrics = new MetricsRegistry();
    for (let i = 1; i <= 1000; i += 1) metrics.recordCall("document/getSymbols", i);

    const [activity] = metrics.snapshot().methods;
    expect(activity?.method).toBe("document/getSymbols");
    expect(activity?.calls).toBe(1000);
    // The reservoir holds the last 256 samples (745..1000), so the percentiles describe recent
    // traffic rather than the whole history — which is what a dashboard is asked about.
    expect(activity?.p50).toBeGreaterThan(800);
    expect(activity?.p95).toBeGreaterThan(activity?.p50 ?? 0);
  });

  it("keeps refusals by code, and attributes them to a method only when one is known", () => {
    const metrics = new MetricsRegistry();
    metrics.recordRefusal("INDEX_NOT_READY", "workspace/searchSymbols");
    metrics.recordRefusal("INDEX_NOT_READY", "workspace/searchSymbols");
    metrics.recordRefusal("STALE_SYMBOL", "symbol/getDefinition");
    // A malformed request has no method to attribute; guessing one would put invented traffic in the
    // panel.
    metrics.recordRefusal("INVALID_REQUEST");

    const snapshot = metrics.snapshot();
    expect(snapshot.refusals).toEqual([
      { code: "INDEX_NOT_READY", count: 2 },
      { code: "INVALID_REQUEST", count: 1 },
      { code: "STALE_SYMBOL", count: 1 },
    ]);
    expect(snapshot.methods).toEqual([]);
  });

  it("counts incomplete answers per method", () => {
    const metrics = new MetricsRegistry();
    metrics.recordIncomplete("workspace/searchSymbols");
    metrics.recordIncomplete("workspace/searchSymbols");
    metrics.recordIncomplete("diagnostics/getSnapshot");

    expect(metrics.snapshot().incomplete).toEqual([
      { method: "workspace/searchSymbols", count: 2 },
      { method: "diagnostics/getSnapshot", count: 1 },
    ]);
  });

  it("keeps recent queries newest first, capped, and forgettable", () => {
    const metrics = new MetricsRegistry();
    for (let i = 0; i < 200; i += 1) {
      metrics.recordQuery(`query ${i}`, "workspace/searchSymbols", 1_000 + i);
    }

    const snapshot = metrics.snapshot();
    expect(snapshot.queries).toHaveLength(snapshot.queryRingCapacity);
    // Newest first: a reader looking at the top of the panel is looking at what just happened.
    expect(snapshot.queries[0]?.query).toBe("query 199");
    // And nothing older than the window survives, so the buffer is a window and not a history.
    expect(snapshot.queries.some((entry) => entry.query === "query 0")).toBe(false);

    metrics.forgetQueries();
    expect(metrics.snapshot().queries).toEqual([]);
  });

  it("drops blank queries rather than storing empty rows", () => {
    const metrics = new MetricsRegistry();
    metrics.recordQuery("   ", "workspace/searchSymbols");
    expect(metrics.snapshot().queries).toEqual([]);
  });

  it("hands out a copy, so a reader cannot mutate the daemon's counters", () => {
    const metrics = new MetricsRegistry();
    metrics.recordQuery("kept", "workspace/searchSymbols");
    metrics.recordIncomplete("workspace/searchSymbols");

    const snapshot = metrics.snapshot();
    (snapshot.queries as RecentQueryLike[]).length = 0;

    expect(metrics.snapshot().queries).toHaveLength(1);
    expect(metrics.snapshot().incomplete).toHaveLength(1);
  });

  it("ignores nonsense durations instead of poisoning the percentiles", () => {
    const metrics = new MetricsRegistry();
    metrics.recordCall("document/read", Number.NaN);
    metrics.recordCall("document/read", -5);
    metrics.recordCall("document/read", 10);

    const [activity] = metrics.snapshot().methods;
    // All three are calls — the request happened — but only the usable sample shapes the latency.
    expect(activity?.calls).toBe(3);
    expect(activity?.p50).toBe(10);
  });
});

interface RecentQueryLike {
  query: string;
}
