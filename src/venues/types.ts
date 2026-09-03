/** Shared executor surface. Replay implements it against bars today; live/paper implement it against Agent OS MCP. */
import type { Fill, TradeIntent, Venue } from "../types.js";

export interface Executor {
  venue: Venue;
  /** Current equity in quote currency. */
  equity(): number;
  /** Latest observed price (replay: last bar close; live: ticker). */
  lastPrice(symbol: string): number;
  /** Market buy of the intent's qty. Fills honestly or throws — never fabricates. */
  marketBuy(intent: TradeIntent): Promise<Fill>;
  /** Market sell of a quantity (exits). */
  marketSell(symbol: string, qty: number, refIntentId: string): Promise<Fill>;
}
