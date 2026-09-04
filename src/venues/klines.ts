/**
 * Historical klines fetcher (public market data — no API key, no auth).
 *
 * Exists so the walk-forward proof is reproducible from a clean clone: the
 * committed CSVs are a convenience, this is the regenerator. Paginates the
 * public endpoint 1000 bars at a time and writes canonical Binance CSV rows.
 *
 * Host fallback order matters: data-api.binance.vision is the market-data-only
 * mirror and stays reachable in regions where api.binance.com is geo-blocked.
 * Market data needs no credentials, so trying mirrors leaks nothing.
 */

export const KLINE_HOSTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api-gcp.binance.com",
] as const;

/** Interval → milliseconds. Used for pagination cursors and gap checks. */
export const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
};

export type KlineRow = (string | number)[];

const MAX_LIMIT = 1000;

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) {
      // Surface Binance's own error body — it explains geo blocks and bad symbols.
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Tries each host in order; returns the first that answers. */
async function getJsonAnyHost(path: string, timeoutMs: number): Promise<unknown> {
  const errors: string[] = [];
  for (const host of KLINE_HOSTS) {
    try {
      return await getJson(`${host}${path}`, timeoutMs);
    } catch (e) {
      errors.push(`${host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`all klines hosts failed —\n  ${errors.join("\n  ")}`);
}

export interface FetchKlinesOpts {
  symbol: string;
  interval: string;
  /** Inclusive start (ms). */
  startMs: number;
  /** Exclusive end (ms). */
  endMs: number;
  timeoutMs?: number;
  /** Called after each page so long fetches show progress. */
  onProgress?: (fetched: number, throughMs: number) => void;
}

/**
 * Fetches [startMs, endMs) as canonical Binance kline rows, ascending by
 * openTime, de-duplicated. Stops when the exchange runs out of history rather
 * than looping forever on a short listing.
 */
export async function fetchKlines(opts: FetchKlinesOpts): Promise<KlineRow[]> {
  const step = INTERVAL_MS[opts.interval];
  if (!step) throw new Error(`unsupported interval "${opts.interval}" (have: ${Object.keys(INTERVAL_MS).join(",")})`);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const out: KlineRow[] = [];
  const seen = new Set<number>();
  let cursor = opts.startMs;

  while (cursor < opts.endMs) {
    const path =
      `/api/v3/klines?symbol=${encodeURIComponent(opts.symbol.toUpperCase())}` +
      `&interval=${encodeURIComponent(opts.interval)}` +
      `&startTime=${cursor}&endTime=${opts.endMs - 1}&limit=${MAX_LIMIT}`;
    const page = (await getJsonAnyHost(path, timeoutMs)) as KlineRow[];
    if (!Array.isArray(page)) throw new Error(`unexpected klines payload for ${opts.symbol}`);
    if (page.length === 0) break; // no more history in this window

    let added = 0;
    for (const row of page) {
      const t = Number(row[0]);
      if (!Number.isFinite(t) || seen.has(t) || t >= opts.endMs) continue;
      seen.add(t);
      out.push(row);
      added++;
    }
    const last = Number(page[page.length - 1]?.[0] ?? 0);
    if (!Number.isFinite(last) || last <= 0) break;
    // Advance past the last bar we saw. If a page was entirely duplicates we
    // still move forward, so this always terminates.
    cursor = last + step;
    opts.onProgress?.(out.length, last);
    if (added === 0 && page.length < MAX_LIMIT) break;
    if (page.length < MAX_LIMIT) continue; // partial page: likely caught up
  }

  out.sort((a, b) => Number(a[0]) - Number(b[0]));
  return out;
}

/** Serializes rows as the comma-separated form the replay loader reads. */
export function toCsv(rows: KlineRow[]): string {
  return rows.map((r) => r.join(",")).join("\n") + "\n";
}

export interface GapReport {
  bars: number;
  expected: number;
  missing: number;
  firstMs: number;
  lastMs: number;
}

/** Integrity check: how many bars are absent versus a gapless series. */
export function checkGaps(rows: KlineRow[], interval: string): GapReport {
  const step = INTERVAL_MS[interval] ?? 0;
  if (rows.length === 0 || step === 0) {
    return { bars: rows.length, expected: 0, missing: 0, firstMs: 0, lastMs: 0 };
  }
  const first = Number(rows[0]?.[0] ?? 0);
  const last = Number(rows[rows.length - 1]?.[0] ?? 0);
  const expected = Math.floor((last - first) / step) + 1;
  return { bars: rows.length, expected, missing: Math.max(0, expected - rows.length), firstMs: first, lastMs: last };
}
