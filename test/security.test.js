import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function startServer() {
  const port = await availablePort();
  const token = "test-bridge-token-".padEnd(48, "X");
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port), GAIA_MCP_TOKEN: token, DATABASE_URL: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let diagnostics = "";
  child.stderr.on("data", (d) => { diagnostics += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i=0; i<80; i++) {
    if (child.exitCode !== null) throw new Error("Bridge exited early: " + diagnostics);
    try {
      const res=await fetch(base + "/");
      if (res.status===200) return {base,token,child};
    } catch { /* Startup is not complete. */ }
    await new Promise((resolve)=>setTimeout(resolve,100));
  }
  child.kill();
  throw new Error("Bridge failed startup: " + diagnostics);
}

test("MCP rejects requests without valid credentials and limits request bodies", async () => {
  const {base,token,child}=await startServer();
  try {
    const unauthorized = await fetch(base + "/mcp", {
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",method:"tools/list",id:1})
    });
    assert.equal(unauthorized.status,401);

    const oversized = await fetch(base + "/mcp", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},
      body:JSON.stringify({data:"Z".repeat(105000)})
    });
    assert.equal(oversized.status,413);


    // Exercise the real MCP transport, not only the Express authentication layer.
    const initialize = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"security-smoke",version:"1.0"}}
      })
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId, "MCP initialization should establish a session");
    const initializeBody = await initialize.text();
    assert.match(initializeBody, /serverInfo/);

    const toolsList = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer " + token,
        "MCP-Session-ID": sessionId
      },
      body: JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})
    });
    assert.equal(toolsList.status, 200);
    const toolsBody = await toolsList.text();
    assert.match(toolsBody, /gaia_control_tower/);
    assert.match(toolsBody, /gaia_project_list/);

    const health = await fetch(base + "/health");
    assert.equal(health.status,503); // No database configured in this isolated test.
  } finally {
    child.kill();
  }
});
