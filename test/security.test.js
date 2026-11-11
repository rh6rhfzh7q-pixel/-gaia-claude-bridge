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

async function startServer(extraEnv = {}) {
  const port = await availablePort();
  const token = "test-bridge-token-".padEnd(48, "X");
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port), GAIA_MCP_TOKEN: token, DATABASE_URL: "", ...extraEnv },
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
    assert.match(toolsBody, /gaia_task_send/);
    assert.match(toolsBody, /gaia_task_complete/);
    assert.match(toolsBody, /gaia_task_claim/);
    assert.match(toolsBody, /gaia_task_list/);

    // Unknown session (e.g. after a deploy) must be 404 so clients re-initialize.
    const stale = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer " + token,
        "MCP-Session-ID": "00000000-0000-0000-0000-000000000000"
      },
      body: JSON.stringify({jsonrpc:"2.0",id:3,method:"tools/list",params:{}})
    });
    assert.equal(stale.status, 404);

    // A non-initialize request without session is rejected without creating a session.
    const noSession = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify({jsonrpc:"2.0",id:4,method:"tools/list",params:{}})
    });
    assert.equal(noSession.status, 400);
    assert.equal(noSession.headers.get("mcp-session-id"), null);

    const staleGet = await fetch(base + "/mcp", {
      headers: {"Authorization": "Bearer " + token, "MCP-Session-ID": "unknown-session"}
    });
    assert.equal(staleGet.status, 404);

    const health = await fetch(base + "/health");
    assert.equal(health.status,503); // No database configured in this isolated test.
  } finally {
    child.kill();
  }
});

const CLAUDE_TOKEN = "test-claude-token-".padEnd(48, "C");
const CHATGPT_TOKEN = "test-chatgpt-token-".padEnd(48, "G");

async function mcp(base, token, body, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": "Bearer " + token
  };
  if (sessionId) headers["MCP-Session-ID"] = sessionId;
  return fetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

async function openSession(base, token) {
  const init = await mcp(base, token, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"identity-test",version:"1.0"}}
  });
  assert.equal(init.status, 200);
  await init.text();
  const sid = init.headers.get("mcp-session-id");
  await (await mcp(base, token, {jsonrpc:"2.0",method:"notifications/initialized"}, sid)).text();
  return sid;
}

async function callTool(base, token, sid, name, args) {
  const res = await mcp(base, token, {jsonrpc:"2.0",id:7,method:"tools/call",params:{name,arguments:args}}, sid);
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return { status: res.status, body: JSON.parse(line ? line.slice(5) : text) };
}

test("identity: per-assistant tokens, session binding and task-tool authorization", async () => {
  const {base,token:legacy,child}=await startServer({ GAIA_MCP_TOKEN_CLAUDE: CLAUDE_TOKEN, GAIA_MCP_TOKEN_CHATGPT: CHATGPT_TOKEN });
  try {
    // Task tools no longer accept caller-chosen identity fields.
    const sidClaude = await openSession(base, CLAUDE_TOKEN);
    const list = await mcp(base, CLAUDE_TOKEN, {jsonrpc:"2.0",id:2,method:"tools/list",params:{}}, sidClaude);
    const tools = JSON.parse((await list.text()).split("\n").find((l)=>l.startsWith("data:")).slice(5)).result.tools;
    for (const name of ["gaia_task_send","gaia_task_claim","gaia_task_complete","gaia_task_get","gaia_task_list","gaia_task_heartbeat"]) {
      const props = Object.keys(tools.find((t)=>t.name===name).inputSchema.properties || {});
      assert.ok(!props.includes("sender") && !props.includes("actor"), `${name} must not accept sender/actor`);
    }

    // A session is bound to the principal that opened it.
    const hijack = await mcp(base, CHATGPT_TOKEN, {jsonrpc:"2.0",id:3,method:"tools/list",params:{}}, sidClaude);
    assert.equal(hijack.status, 403);
    const hijackGet = await fetch(base + "/mcp", { headers: {"Authorization":"Bearer "+CHATGPT_TOKEN, "MCP-Session-ID": sidClaude} });
    assert.equal(hijackGet.status, 403);

    // The shared legacy token keeps the old tools but cannot use task tools.
    const sidLegacy = await openSession(base, legacy);
    const denied = await callTool(base, legacy, sidLegacy, "gaia_task_list", {});
    assert.equal(denied.body.result.isError, true);
    assert.match(denied.body.result.content[0].text, /Forbidden/);
    const status = await callTool(base, legacy, sidLegacy, "gaia_status", {});
    assert.match(status.body.result.content[0].text, /operational/);

    // An assistant token reaches the task layer (here: no database configured).
    const allowed = await callTool(base, CLAUDE_TOKEN, sidClaude, "gaia_task_list", {});
    assert.doesNotMatch(allowed.body.result.content[0].text, /Forbidden/);

    // Pre-existing tools: with an assistant token the self-reported identity
    // field must match the principal; the legacy token keeps its behaviour.
    const spoof = await callTool(base, CLAUDE_TOKEN, sidClaude, "gaia_message_send",
      {project_key:"x",sender:"chatgpt",recipient:"chatgpt",subject:"s",body:"b"});
    assert.match(spoof.body.result.content[0].text, /Forbidden: sender must match/);
    const asUser = await callTool(base, CLAUDE_TOKEN, sidClaude, "gaia_project_update",
      {project_key:"x",summary:"s",status:"s",actor:"user",expected_version:1});
    assert.match(asUser.body.result.content[0].text, /Forbidden: actor must match/);
    const foreignInbox = await callTool(base, CLAUDE_TOKEN, sidClaude, "gaia_message_inbox", {recipient:"chatgpt"});
    assert.match(foreignInbox.body.result.content[0].text, /Forbidden: recipient must match/);
    const own = await callTool(base, CLAUDE_TOKEN, sidClaude, "gaia_message_send",
      {project_key:"x",sender:"claude",recipient:"chatgpt",subject:"s",body:"b"});
    assert.doesNotMatch(own.body.result.content[0].text, /Forbidden/, "matching identity passes to the data layer");
    const legacySend = await callTool(base, legacy, sidLegacy, "gaia_message_send",
      {project_key:"x",sender:"chatgpt",recipient:"claude",subject:"s",body:"b"});
    assert.doesNotMatch(legacySend.body.result.content[0].text, /Forbidden/, "legacy token unchanged");

    // Unknown tokens are rejected.
    assert.equal((await mcp(base, "x".repeat(48), {jsonrpc:"2.0",id:9,method:"tools/list",params:{}})).status, 401);
  } finally {
    child.kill();
  }
});

test("fail closed when two principals share the same token", async () => {
  const same = "duplicate-token-".padEnd(48, "D");
  const {base,child}=await startServer({ GAIA_MCP_TOKEN: "", GAIA_MCP_TOKEN_CLAUDE: same, GAIA_MCP_TOKEN_CHATGPT: same });
  try {
    const res = await mcp(base, same, {jsonrpc:"2.0",id:1,method:"tools/list",params:{}});
    assert.equal(res.status, 503);
  } finally {
    child.kill();
  }
});
