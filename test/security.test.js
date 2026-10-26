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

    const health = await fetch(base + "/health");
    assert.equal(health.status,503); // No database configured in this isolated test.
  } finally {
    child.kill();
  }
});
