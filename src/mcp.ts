/**
 * Raw JSON-RPC client for the Binance Agent OS MCP (Streamable HTTP).
 * No SDK — initialize → tools/list → tools/call over plain fetch. Small
 * enough to audit, which matters when it will one day move real money.
 */
export const MCP_URL = "https://agent.binance.com/mcp/agentic";

export interface McpToken {
  access_token: string;
  token_type: string;
  expires_in?: number;
  obtained_at: number;
}

export function authHeaders(token: McpToken): Record<string, string> {
  return { Authorization: `${token.token_type ?? "Bearer"} ${token.access_token}` };
}

async function rpc(
  token: McpToken,
  body: unknown,
  sessionId?: string,
): Promise<{ json: unknown; sessionId?: string }> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeaders(token),
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error("MCP 401 — token expired or missing (re-run `ratchet auth login`)");
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  // Streamable HTTP may wrap JSON-RPC in an SSE envelope; unwrap if needed.
  const payload = text.startsWith("event:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
    : text;
  const sid = res.headers.get("Mcp-Session-Id") ?? sessionId;
  const out: { json: unknown; sessionId?: string } = { json: JSON.parse(payload) };
  if (sid) out.sessionId = sid;
  return out;
}

/** Initialize a session, then list tools. The Day-1 spike in one call. */
export async function listTools(token: McpToken): Promise<{ sessionId?: string; tools: { name: string; description?: string }[] }> {
  const init = await rpc(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ratchet-spike", version: "0.1.0" },
    },
  });
  await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  const listed = (await rpc(
    token,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    init.sessionId,
  )) as { json: { result?: { tools?: { name: string; description?: string }[] } } };
  const tools = listed.json.result?.tools ?? [];
  if (init.sessionId) return { sessionId: init.sessionId, tools };
  return { tools };
}

export async function callTool(
  token: McpToken,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const out = (await rpc(
    token,
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } },
    sessionId,
  )) as { json: { result?: unknown; error?: unknown } };
  if (out.json.error) throw new Error(`MCP tool error: ${JSON.stringify(out.json.error).slice(0, 300)}`);
  return out.json.result;
}
