// Regression test for the stale-session bug ("HTTP 400 Server not initialized").
// After a bridge restart (Render redeploy or free-tier spin-down) all in-memory
// MCP sessions are gone. Per the MCP Streamable HTTP spec the server MUST answer
// requests carrying an unknown Mcp-Session-Id with 404, so the client starts a
// new session. No database is used (DATABASE_URL empty).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

const TOKEN = "test-bridge-token-".padEnd(48, "X");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(port, env = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port), GAIA_MCP_TOKEN: TOKEN, DATABASE_URL: "", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let diagnostics = "";
  child.stderr.on("data", (d) => { diagnostics += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("Bridge exited early: " + diagnostics);
    try {
      const res = await fetch(base + "/");
      if (res.status === 200) return { base, child };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("Bridge failed startup: " + diagnostics);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exited;
}

const headers = (extra = {}) => ({
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
  "Authorization": "Bearer " + TOKEN,
  ...extra
});

const initializeBody = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "session-recovery", version: "1.0" } }
});

async function initialize(base) {
  const res = await fetch(base + "/mcp", { method: "POST", headers: headers(), body: initializeBody });
  assert.equal(res.status, 200);
  const sessionId = res.headers.get("mcp-session-id");
  assert.ok(sessionId);
  await res.text();
  await fetch(base + "/mcp", {
    method: "POST",
    headers: headers({ "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" }),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  }).then((r) => r.text());
  return sessionId;
}

const toolsList = (base, sessionId) => fetch(base + "/mcp", {
  method: "POST",
  headers: headers({ "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" }),
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
});

test("stale session after restart: 404 and successful re-initialization", async () => {
  const port = await availablePort();
  let { base, child } = await startServer(port);
  let staleSession;
  try {
    staleSession = await initialize(base);
    const before = await toolsList(base, staleSession);
    assert.equal(before.status, 200, "session works before restart");
    assert.match(await before.text(), /gaia_status/);
  } finally {
    await stopServer(child);
  }

  // Simulated Render restart: same URL, empty in-memory session table.
  ({ base, child } = await startServer(port));
  try {
    const after = await toolsList(base, staleSession);
    const body = await after.text();
    assert.equal(after.status, 404, `unknown session must be 404 (got ${after.status}: ${body})`);
    assert.match(body, /Session not found/);

    const fresh = await initialize(base);
    assert.notEqual(fresh, staleSession);
    const again = await toolsList(base, fresh);
    assert.equal(again.status, 200, "client recovers with a new session");
    assert.match(await again.text(), /gaia_status/);
  } finally {
    await stopServer(child);
  }
});

test("session handling edge cases", async () => {
  const port = await availablePort();
  const { base, child } = await startServer(port);
  try {
    // Non-initialize request without a session: rejected, no transport created.
    const noSession = await fetch(base + "/mcp", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    });
    assert.equal(noSession.status, 400);
    assert.match(await noSession.text(), /initialize/i);

    // GET / DELETE: missing session 400, unknown session 404.
    for (const method of ["GET", "DELETE"]) {
      const missing = await fetch(base + "/mcp", { method, headers: headers() });
      assert.equal(missing.status, 400, `${method} without session`);
      await missing.text();
      const unknown = await fetch(base + "/mcp", { method, headers: headers({ "mcp-session-id": "00000000-0000-0000-0000-000000000000" }) });
      assert.equal(unknown.status, 404, `${method} with unknown session`);
      await unknown.text();
    }

    // Authentication is unchanged and still runs first.
    const unauth = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": "00000000-0000-0000-0000-000000000000" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" })
    });
    assert.equal(unauth.status, 401);
    await unauth.text();

    // Valid session: DELETE terminates it, afterwards it is unknown (404).
    const sid = await initialize(base);
    const del = await fetch(base + "/mcp", { method: "DELETE", headers: headers({ "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }) });
    assert.equal(del.status, 200);
    await del.text();
    const gone = await toolsList(base, sid);
    assert.equal(gone.status, 404);
    await gone.text();
  } finally {
    await stopServer(child);
  }
});

test("token not configured still fails closed with 503", async () => {
  const port = await availablePort();
  const { base, child } = await startServer(port, { GAIA_MCP_TOKEN: "" });
  try {
    const res = await fetch(base + "/mcp", { method: "POST", headers: headers(), body: initializeBody });
    assert.equal(res.status, 503);
    await res.text();
  } finally {
    await stopServer(child);
  }
});
