// Principal resolution for the GAIA bridge.
//
// Each assistant gets its own bearer token, so the server – not the caller –
// decides who is acting:
//   GAIA_MCP_TOKEN_CLAUDE  -> principal "claude"
//   GAIA_MCP_TOKEN_CHATGPT -> principal "chatgpt"
//   GAIA_MCP_TOKEN         -> principal "legacy" (existing shared token; kept so
//                             current connectors keep working, but it has NO
//                             access to the task tools)
//
// Fail closed: no valid token configured, or two variables with the same value
// (identity would be ambiguous) -> 503. Tokens shorter than 32 characters are
// ignored. Comparison is constant-time per candidate.
import { timingSafeEqual } from "node:crypto";

export const TASK_PRINCIPALS = new Set(["claude", "chatgpt"]);

const SOURCES = [
  ["claude", "GAIA_MCP_TOKEN_CLAUDE"],
  ["chatgpt", "GAIA_MCP_TOKEN_CHATGPT"],
  ["legacy", "GAIA_MCP_TOKEN"]
];

export function readPrincipalTokens(env = process.env) {
  const tokens = [];
  for (const [principal, name] of SOURCES) {
    const value = env[name];
    if (typeof value === "string" && value.length >= 32) tokens.push({ principal, value });
  }
  const values = tokens.map((t) => t.value);
  if (new Set(values).size !== values.length) return { ok: false, reason: "duplicate_tokens" };
  if (!tokens.length) return { ok: false, reason: "not_configured" };
  return { ok: true, tokens };
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function resolvePrincipal(authorizationHeader, env = process.env) {
  const config = readPrincipalTokens(env);
  if (!config.ok) return { status: "unconfigured", reason: config.reason };
  const header = typeof authorizationHeader === "string" ? authorizationHeader : "";
  let match = null;
  for (const { principal, value } of config.tokens) {
    // Evaluate every candidate to keep timing independent of which one matches.
    if (safeEqual(header, "Bearer " + value) && match === null) match = principal;
  }
  return match ? { status: "ok", principal: match } : { status: "unauthorized" };
}
