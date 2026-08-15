/**
 * What the daemon can say about itself, counted rather than narrated.
 *
 * Every number here has a source in something the daemon already does: it routes a bounded set of
 * methods, and it refuses with a bounded set of codes. That is why this exists at all — the panel a
 * maintainer of this product wants first is **refusals by reason**, because everything from ADR-0030 to
 * ADR-0034 is built so an agent hears "I could not look" instead of "there is nothing", and a spike in
 * `INDEX_NOT_READY` or `STALE_SYMBOL` is that principle made legible (ADR-0035).
 *
 * **What is deliberately absent.** Symbol-handle relocation counters were designed and then removed: the
 * outcomes a daemon can see — `STALE_SYMBOL`, `AMBIGUOUS_SYMBOL` — are already refusal codes counted
 * below, and a *successful* relocation happens inside an adapter and is invisible from here. Keeping the
 * fields would have shipped a panel that could only ever be partly true.
 *
 * **Bounded by construction.** Counters are keyed by method and by error code. Both are closed sets in the
 * protocol, which is what keeps the maps from growing with traffic; the parameters are typed `string`
 * rather than those unions because a caller may hold a value the protocol has not yet named, and a union
 * with `string` in it would claim to be closed while accepting anything. Latency keeps a fixed-size reservoir per
 * method rather than every sample. Queries keep a capped ring.
 *
 * **Counting is not a way around redaction.** ADR-0011 forbids logging payloads, and nothing here is
 * written to a log: this is in-memory state a local reader can ask for. The one place user text is kept
 * at all is [recordQuery], deliberately and under the constraints ADR-0035 sets — memory only, capped,
 * never emitted through the logger, and hideable by the reader.
 */

/** How many latency samples are kept per method. Fixed, so memory does not follow traffic. */
const LATENCY_SAMPLES = 256;

/** How many recent queries are kept. Small on purpose: this is a window, not a history. */
const QUERY_RING = 50;

export interface MethodActivity {
  readonly method: string;
  readonly calls: number;
  readonly refusals: number;
  /** Milliseconds. Rounded to a tenth; a percentile of a reservoir is an estimate, not a measurement. */
  readonly p50: number;
  readonly p95: number;
}

export interface RecentQuery {
  readonly query: string;
  readonly method: string;
  /** Wall-clock milliseconds, for "2 min ago" in a reader. */
  readonly at: number;
}

export interface MetricsSnapshot {
  readonly methods: readonly MethodActivity[];
  /** Refusals per normalized error code, highest first. */
  readonly refusals: readonly { readonly code: string; readonly count: number }[];
  /** Responses that carried `truncated: true`, per method. */
  readonly incomplete: readonly { readonly method: string; readonly count: number }[];
  /** Newest first. Capped; see [QUERY_RING]. */
  readonly queries: readonly RecentQuery[];
  readonly queryRingCapacity: number;
}

export class MetricsRegistry {
  readonly #calls = new Map<string, number>();
  readonly #refusalsByMethod = new Map<string, number>();
  readonly #refusalsByCode = new Map<string, number>();
  readonly #incomplete = new Map<string, number>();
  readonly #latency = new Map<string, number[]>();
  #queries: RecentQuery[] = [];

  /** A method was answered, in [durationMs]. Counted whether the answer was a result or a refusal. */
  recordCall(method: string, durationMs: number): void {
    this.#calls.set(method, (this.#calls.get(method) ?? 0) + 1);
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const samples = this.#latency.get(method) ?? [];
    // A reservoir, not a log: past the cap the oldest sample goes. Percentiles drift toward the
    // recent, which is what a dashboard is asked about.
    if (samples.length >= LATENCY_SAMPLES) samples.shift();
    samples.push(durationMs);
    this.#latency.set(method, samples);
  }

  /**
   * A request was refused, with [code].
   *
   * The method is optional because a refusal can precede knowing it — a malformed request has no
   * method to attribute, and attributing it to a guess would put invented traffic in the panel.
   */
  recordRefusal(code: string, method?: string): void {
    this.#refusalsByCode.set(code, (this.#refusalsByCode.get(code) ?? 0) + 1);
    if (method !== undefined) {
      this.#refusalsByMethod.set(method, (this.#refusalsByMethod.get(method) ?? 0) + 1);
    }
  }

  /** A response carried `truncated: true` — the workspace held more than the answer did. */
  recordIncomplete(method: string): void {
    this.#incomplete.set(method, (this.#incomplete.get(method) ?? 0) + 1);
  }

  /**
   * A query a consumer issued.
   *
   * Kept as text on purpose (ADR-0035): a count says "47 searches", a query says what the agent is
   * doing, and the reader is the person whose IDE was searched. Blank queries are dropped rather than
   * stored as empty rows.
   */
  recordQuery(query: string, method: string, at: number = Date.now()): void {
    if (query.trim().length === 0) return;
    this.#queries.unshift({ query, method, at });
    if (this.#queries.length > QUERY_RING) this.#queries = this.#queries.slice(0, QUERY_RING);
  }

  /** A reader's view. A copy, so a reader cannot mutate the daemon's counters by holding it. */
  snapshot(): MetricsSnapshot {
    const methods: MethodActivity[] = [...this.#calls.entries()]
      .map(([method, calls]) => {
        const samples = [...(this.#latency.get(method) ?? [])].sort((a, b) => a - b);
        return {
          method,
          calls,
          refusals: this.#refusalsByMethod.get(method) ?? 0,
          p50: percentile(samples, 0.5),
          p95: percentile(samples, 0.95),
        };
      })
      .sort((a, b) => b.calls - a.calls || a.method.localeCompare(b.method));

    return {
      methods,
      refusals: [...this.#refusalsByCode.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
      incomplete: [...this.#incomplete.entries()]
        .map(([method, count]) => ({ method, count }))
        .sort((a, b) => b.count - a.count || a.method.localeCompare(b.method)),
      queries: [...this.#queries],
      queryRingCapacity: QUERY_RING,
    };
  }

  /** Forgets every query, for a reader who wants them gone now rather than at the next restart. */
  forgetQueries(): void {
    this.#queries = [];
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank on a reservoir. Interpolating would suggest a precision the sampling does not have.
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round((sorted[index] ?? 0) * 10) / 10;
}
