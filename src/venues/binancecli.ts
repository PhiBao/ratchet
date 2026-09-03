/**
 * binance-cli venue executor (official Binance CLI — the sanctioned
 * programmatic path; no OAuth agent gate). Shells out to `binance-cli`,
 * parses its JSON, and recovers fills by order id — never resubmits blindly.
 *
 * Profiles carry the keys (testnet first). Ratchet never sees raw secrets:
 * they live in the CLI's own profile store.
 */
import { spawn } from "node:child_process";
import type { Fill, TradeIntent } from "../types.js";

export interface CliVenueOpts {
  /** binance-cli profile name, e.g. "ratchet-testnet". */
  profile: string;
  /** Venue label journaled on fills. */
  venue: "testnet" | "agentic-live";
  timeoutMs?: number;
}

function run(args: string[], timeoutMs: number): Promise<string> {
  // NOTE: spawn with stdin ignored. execFile leaves stdin as an open pipe and
  // binance-cli blocks forever waiting on it for signed requests (hangs until
  // timeout SIGTERMs it). "ignore" gives it EOF semantics like </dev/null.
  return new Promise((resolve, reject) => {
    const child = spawn("binance-cli", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 4 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`binance-cli ${args.slice(0, 3).join(" ")}… timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`binance-cli spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`binance-cli ${args.slice(0, 3).join(" ")}… failed: ${(stderr || `exit ${code}`).slice(0, 300)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // Some commands wrap JSON in prose; carve the first {...} or [...].
    const start = t.search(/[[{]/);
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error(`unparseable binance-cli output: ${t.slice(0, 200)}`);
  }
}

interface OrderResult {
  symbol: string;
  orderId: number;
  transactTime: number;
  fills?: { price: string; qty: string; commission: string; commissionAsset: string }[];
  cummulativeQuoteQty?: string;
  status?: string;
}

/** Weighted-average fill from a new-order RESULT/FULL response. */
export function fillFromOrder(intent: TradeIntent, venue: "testnet" | "agentic-live", res: OrderResult, nowIso: string): Fill {
  const fills = res.fills ?? [];
  let qty = 0;
  let notional = 0;
  let fee = 0;
  let feeAsset = "USDT";
  for (const f of fills) {
    const q = Number(f.qty);
    const p = Number(f.price);
    qty += q;
    notional += q * p;
    fee += Number(f.commission);
    if (f.commissionAsset) feeAsset = f.commissionAsset;
  }
  if (qty <= 0) throw new Error(`order ${res.orderId} has no fills (status ${res.status ?? "?"}) — refusing to invent one`);
  return {
    intentId: intent.id,
    venue,
    price: notional / qty,
    qty,
    fee,
    feeAsset,
    ts: nowIso,
    orderId: String(res.orderId),
  };
}

export class BinanceCliVenue {
  private opts: Required<CliVenueOpts>;
  constructor(opts: CliVenueOpts) {
    this.opts = { timeoutMs: 30000, ...opts };
  }

  private args(...rest: string[]): string[] {
    // --profile is a per-subcommand flag in binance-cli 2.x, not a global.
    return [...rest, "--profile", this.opts.profile];
  }

  async serverTime(): Promise<number> {
    const out = (await run(this.args("spot", "time"), this.opts.timeoutMs)) as string;
    const j = parseJsonLoose(out) as { serverTime?: number };
    return j.serverTime ?? Date.now();
  }

  async price(symbol: string): Promise<number> {
    const out = await run(this.args("spot", "ticker-price", "--symbol", symbol), this.opts.timeoutMs);
    const j = parseJsonLoose(out) as { price?: string };
    const p = Number(j.price);
    if (!p) throw new Error(`no price for ${symbol}`);
    return p;
  }

  /** MARKET buy by quote qty (USDT). Deterministic client id = intent id hash. */
  async marketBuy(intent: TradeIntent, clientOrderId: string): Promise<Fill> {
    const out = await run(
      this.args(
        "spot", "new-order",
        "--symbol", intent.symbol,
        "--side", "BUY",
        "--type", "MARKET",
        "--quote-order-qty", intent.usdNotional.toFixed(2),
        "--new-client-order-id", clientOrderId,
        "--new-order-resp-type", "FULL",
      ),
      this.opts.timeoutMs,
    );
    const res = parseJsonLoose(out) as OrderResult;
    return fillFromOrder(intent, this.opts.venue, res, new Date().toISOString());
  }

  /** Recover an ambiguous order by exchange order id (exact id only — never guess). */
  async getOrder(symbol: string, orderId: string): Promise<OrderResult> {
    const out = await run(this.args("spot", "get-order", "--symbol", symbol, "--order-id", orderId), this.opts.timeoutMs);
    return parseJsonLoose(out) as OrderResult;
  }

  /** Authoritative fills for reconciliation (exchange record, not ours). */
  async myTrades(symbol: string, orderId?: string): Promise<unknown> {
    const extra = orderId ? ["--order-id", orderId] : [];
    const out = await run(this.args("spot", "my-trades", "--symbol", symbol, ...extra), this.opts.timeoutMs);
    return parseJsonLoose(out);
  }

  async balances(): Promise<{ asset: string; free: string; locked: string }[]> {
    const out = await run(this.args("spot", "get-account", "--omit-zero-balances"), this.opts.timeoutMs);
    const j = parseJsonLoose(out) as { balances?: { asset: string; free: string; locked: string }[] };
    return j.balances ?? [];
  }
}

/** Presence check for setup guidance (no secrets touched). */
export async function cliPresence(): Promise<{ installed: boolean; version: string }> {
  try {
    const v = await run(["--version"], 10000);
    return { installed: true, version: v.trim() };
  } catch {
    return { installed: false, version: "" };
  }
}
