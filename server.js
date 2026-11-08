import express from "express";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  DISPATCHING_TYPES, TASK_INTAKE_SQL, TASK_SCHEMA_SQL, claimTask, completeTask, createTask, dispatchTask, getTask, heartbeatTask,
  listTasks, readDispatchConfig, readSigningKey, sweep
} from "./tasks.js";
import { TASK_PRINCIPALS, resolvePrincipal } from "./auth.js";

const app = express();
app.use(express.json({ limit: "100kb" }));

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
      query_timeout: 6000,
      max: 10
    })
  : null;

// Never log driver errors: they can contain credentials or query values.
pool?.on("error", () => {
  console.error("GAIA Memory database connection interrupted.");
});

let initialization;
function ensureMemory() {
  if (!pool) {
    return Promise.reject(new Error("GAIA Memory is not configured."));
  }
  if (!initialization) {
    initialization = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS gaia_memory (
          id BIGSERIAL PRIMARY KEY,
          namespace TEXT NOT NULL DEFAULT 'gaia',
          key TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(namespace, key)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS gaia_memory_updated_at_idx
        ON gaia_memory (updated_at DESC)
      `);
    })().catch(() => {
      // A later health check or tool call retries after a temporary failure.
      initialization = undefined;
      throw new Error("GAIA Memory database is unavailable.");
    });
  }
  return initialization;
}

const result = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }]
});
const memoryTool = (handler) => async (args) => {
  try {
    await ensureMemory();
    return result(await handler(args));
  } catch {
    return {
      isError: true,
      content: [{
        type: "text",
        text: pool
          ? "GAIA Memory database is temporarily unavailable."
          : "GAIA Memory is not configured: DATABASE_URL is missing."
      }]
    };
  }
};

function createServer({ principal } = {}) {
  const server = new McpServer({
    name: "gaia-claude-bridge",
    version: "1.0.0"
  }, { maxToolInputElements: 512 });

  // Identity binding for the pre-existing tools: with an assistant token the
  // self-reported actor/sender/recipient field must equal the authenticated
  // principal. The shared legacy token keeps its previous behaviour.
  const ACTOR_FIELDS = {
    gaia_project_update: "actor", gaia_message_send: "sender", gaia_message_inbox: "recipient",
    gaia_message_ack: "actor", gaia_control_item_progress: "actor", gaia_executive_review_record: "actor"
  };
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => {
    const field = ACTOR_FIELDS[name];
    if (!field) return registerTool(name, config, handler);
    return registerTool(name, config, async (args, extra) => {
      if (TASK_PRINCIPALS.has(principal) && args?.[field] !== principal) {
        return { isError: true, content: [{ type: "text", text: `Forbidden: ${field} must match the authenticated principal (${principal}).` }] };
      }
      return handler(args, extra);
    });
  };
  const namespace = z.string().min(1).default("gaia");
  const key = z.string().min(1);

  server.registerTool("gaia_status", {
    description: "Check whether the GAIA Claude Bridge is operational."
  }, async () => ({
    content: [{ type: "text", text: "GAIA Claude Bridge is operational." }]
  }));

  server.registerTool("gaia_memory_status", {
    description: "Check PostgreSQL connectivity and count persistent memory entries."
  }, memoryTool(async () => {
    await pool.query("SELECT 1");
    const { rows } = await pool.query("SELECT COUNT(*) AS count FROM gaia_memory");
    return { database: "online", count: rows[0].count };
  }));

  server.registerTool("gaia_memory_get", {
    description: "Read an exact persistent memory entry by namespace and key.",
    inputSchema: { namespace, key }
  }, memoryTool(async ({ namespace, key }) => {
    const { rows } = await pool.query(
      "SELECT * FROM gaia_memory WHERE namespace = $1 AND key = $2",
      [namespace, key]
    );
    return { memory: rows[0] ?? null };
  }));

  server.registerTool("gaia_memory_search", {
    description: "List memory entries or search key/content using ILIKE, newest first.",
    inputSchema: {
      namespace,
      query: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20)
    }
  }, memoryTool(async ({ namespace, query, limit }) => {
    const { rows } = await pool.query(
      `SELECT * FROM gaia_memory
       WHERE namespace = $1
         AND ($2::text IS NULL OR key ILIKE $2 OR content ILIKE $2)
       ORDER BY updated_at DESC, id DESC LIMIT $3`,
      [namespace, query === undefined ? null : `%${query}%`, limit]
    );
    return { memories: rows };
  }));

  server.registerTool("gaia_memory_upsert", {
    description: "Create or update persistent memory. Omitted metadata becomes an empty object.",
    inputSchema: {
      namespace,
      key,
      content: z.string(),
      metadata: z.record(z.string(), z.json()).default({})
    }
  }, memoryTool(async ({ namespace, key, content, metadata }) => {
    const { rows } = await pool.query(
      `INSERT INTO gaia_memory (namespace, key, content, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (namespace, key) DO UPDATE SET
         content = EXCLUDED.content,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [namespace, key, content, JSON.stringify(metadata)]
    );
    return { memory: rows[0] };
  }));

  server.registerTool("gaia_project_get",{description:"Get shared project state and version",inputSchema:{project_key:key}},memoryTool(async({project_key})=>({project:(await pool.query("SELECT * FROM gaia_project_state WHERE project_key=$1",[project_key])).rows[0]??null})));
  server.registerTool("gaia_project_update",{description:"Versioned project update. expected_version=0 creates new; otherwise match current version. Conflicts never overwrite.",inputSchema:{project_key:key,summary:z.string().min(1),status:z.string().min(1),actor:z.enum(["claude","chatgpt","user"]),expected_version:z.number().int().min(0),metadata:z.record(z.string(),z.json()).default({})}},memoryTool(async({project_key,summary,status,actor,expected_version,metadata})=>{
    const c=await pool.connect();try{await c.query("BEGIN");let q;
    if(expected_version===0)q=await c.query("INSERT INTO gaia_project_state(project_key,summary,status,updated_by,metadata) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(project_key) DO NOTHING RETURNING *",[project_key,summary,status,actor,JSON.stringify(metadata)]);
    else q=await c.query("UPDATE gaia_project_state SET summary=$2,status=$3,updated_by=$4,metadata=$5::jsonb,version=version+1,updated_at=NOW() WHERE project_key=$1 AND version=$6 RETURNING *",[project_key,summary,status,actor,JSON.stringify(metadata),expected_version]);
    if(!q.rows.length){await c.query("ROLLBACK");return{conflict:true,message:"Read latest project version and retry; no data changed"}}
    const p=q.rows[0];const e=await c.query("INSERT INTO gaia_project_events(project_key,event_type,actor,version,payload) VALUES($1,'state_updated',$2,$3,$4::jsonb) RETURNING id",[project_key,actor,p.version,JSON.stringify({summary,status,metadata})]);await c.query("COMMIT");return{conflict:false,project:p,event_id:e.rows[0].id};
    }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
  }));
  server.registerTool("gaia_changes_since",{description:"Read ordered changes after event ID; no automatic wake-up",inputSchema:{after_id:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(50)}},memoryTool(async({after_id,limit})=>({events:(await pool.query("SELECT * FROM gaia_project_events WHERE id>$1 ORDER BY id ASC LIMIT $2",[after_id,limit])).rows})));
  server.registerTool("gaia_message_send",{description:"Store a message for another assistant; does not activate the recipient",inputSchema:{project_key:key,sender:z.enum(["claude","chatgpt","user"]),recipient:z.enum(["claude","chatgpt","both"]),subject:z.string().min(1),body:z.string().min(1)}},memoryTool(async({project_key,sender,recipient,subject,body})=>{
    const c=await pool.connect();try{await c.query("BEGIN");const q=await c.query("INSERT INTO gaia_project_messages(project_key,sender,recipient,subject,body) VALUES($1,$2,$3,$4,$5) RETURNING *",[project_key,sender,recipient,subject,body]);await c.query("INSERT INTO gaia_project_events(project_key,event_type,actor,payload) VALUES($1,'message_sent',$2,$3::jsonb)",[project_key,sender,JSON.stringify({message_id:q.rows[0].id,recipient,subject})]);await c.query("COMMIT");return{message:q.rows[0]}}catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
  }));
  server.registerTool("gaia_message_inbox",{description:"Read internal incoming messages",inputSchema:{recipient:z.enum(["claude","chatgpt"]),status:z.enum(["open","acknowledged","done","all"]).default("open"),limit:z.number().int().min(1).max(100).default(30)}},memoryTool(async({recipient,status,limit})=>({messages:(await pool.query("SELECT * FROM gaia_project_messages WHERE recipient IN ($1,'both') AND ($2='all' OR status=$2) ORDER BY id DESC LIMIT $3",[recipient,status,limit])).rows})));

  server.registerTool("gaia_project_list",{description:"List all current GAIA project states with versions",inputSchema:{limit:z.number().int().min(1).max(100).default(50)}},memoryTool(async({limit})=>({projects:(await pool.query("SELECT * FROM gaia_project_state ORDER BY updated_at DESC LIMIT $1",[limit])).rows})));
  server.registerTool("gaia_message_ack",{description:"Acknowledge or complete an incoming GAIA message. Only the recipient may act.",inputSchema:{id:z.number().int().min(1),actor:z.enum(["claude","chatgpt"]),status:z.enum(["acknowledged","done"])}},memoryTool(async({id,actor,status})=>{
    const c=await pool.connect();try{await c.query("BEGIN");
    const q=await c.query("UPDATE gaia_project_messages SET status=$3,updated_at=NOW() WHERE id=$1 AND recipient IN ($2,'both') AND status IN ('open','acknowledged') RETURNING *",[id,actor,status]);
    if(!q.rows.length){await c.query("ROLLBACK");return{updated:false,message:"No eligible message, or already completed"}}
    await c.query("INSERT INTO gaia_project_events(project_key,event_type,actor,payload) VALUES($1,'message_status_changed',$2,$3::jsonb)",[q.rows[0].project_key,actor,JSON.stringify({message_id:id,status})]);await c.query("COMMIT");return{updated:true,message:q.rows[0]};
    }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
  }));

  server.registerTool("gaia_control_tower",{
    description:"Read the current G.A.I.A. executive portfolio: projects, priorities, risks, dependencies, decisions, inbox counts and change cursor. On-demand only.",
    inputSchema:{recent_events:z.number().int().min(0).max(25).default(10)}
  },memoryTool(async({recent_events})=>{
    const [p,c,m,e,r]=await Promise.all([
      pool.query("SELECT project_key,status,version,updated_at,metadata->>'source' AS source_ref,metadata->>'as_of' AS source_date,LEFT(summary,400) AS summary FROM gaia_project_state WHERE project_key NOT LIKE 'test_%' AND COALESCE(metadata->>'business_project','true')<>'false' ORDER BY project_key"),
      pool.query("SELECT item_key,category,project_key,title,assessment,next_action,owner,importance,status,evidence,source_ref,source_date,related_projects,version,updated_at FROM gaia_control_items WHERE status NOT IN ('closed','superseded') ORDER BY importance ASC,updated_at DESC LIMIT 100"),
      pool.query("SELECT COUNT(*) FILTER (WHERE recipient IN ('claude','both'))::int AS claude_open,COUNT(*) FILTER (WHERE recipient IN ('chatgpt','both'))::int AS chatgpt_open FROM gaia_project_messages WHERE status='open'"),
      pool.query("SELECT id,project_key,event_type,actor,version,created_at FROM gaia_project_events ORDER BY id DESC LIMIT $1",[recent_events]),
      pool.query("SELECT id,scope,reviewed_by,assessment,decision_requests,created_at FROM gaia_control_reviews ORDER BY id DESC LIMIT 1")
    ]);
    return {as_of:new Date().toISOString(),limits:["Only saved information is available; no automatic chat sync or wake-up","Source dates may predate database updates"],projects:p.rows,control_items:c.rows,inbox:m.rows[0],recent_events:e.rows.reverse(),latest_review:r.rows[0]??null};
  }));

  server.registerTool("gaia_control_item_get",{description:"Read one executive control item including provenance and version.",inputSchema:{item_key:key}},memoryTool(async({item_key})=>({item:(await pool.query("SELECT * FROM gaia_control_items WHERE item_key=$1",[item_key])).rows[0]??null})));
  server.registerTool("gaia_control_items_list",{
    description:"List strategic priorities, risks, dependencies, decisions and actions; optionally filter by related project.",
    inputSchema:{
      project_key:z.string().min(1).optional(),
      category:z.enum(["priority","risk","dependency","decision","action"]).optional(),
      status:z.enum(["open","monitor","awaiting_user","closed","superseded","all"]).default("all"),
      limit:z.number().int().min(1).max(100).default(40)
    }
  },memoryTool(async({project_key,category,status,limit})=>({
    items:(await pool.query("SELECT * FROM gaia_control_items WHERE ($1::text IS NULL OR project_key=$1 OR $1=ANY(related_projects)) AND ($2::text IS NULL OR category=$2) AND ($3='all' OR status=$3) ORDER BY importance ASC,updated_at DESC LIMIT $4",[project_key??null,category??null,status,limit])).rows
  })));

  server.registerTool("gaia_control_item_progress",{
    description:"Versioned update of Control Tower status and next action. Source is required; stale updates are rejected.",
    inputSchema:{
      item_key:key,expected_version:z.number().int().min(1),
      status:z.enum(["open","monitor","awaiting_user","closed","superseded"]),
      next_action:z.string(),source_ref:z.string().min(1),
      actor:z.enum(["chatgpt","claude","user"])
    }
  },memoryTool(async({item_key,expected_version,status,next_action,source_ref,actor})=>{
    const c=await pool.connect();
    try{
      await c.query("BEGIN");
      const q=await c.query("UPDATE gaia_control_items SET status=$3,next_action=$4,source_ref=$5,updated_by=$6,version=version+1,updated_at=NOW() WHERE item_key=$1 AND version=$2 RETURNING *",[item_key,expected_version,status,next_action,source_ref,actor]);
      if(!q.rows.length){await c.query("ROLLBACK");return{conflict:true,message:"Read latest version; no changes made"};}
      const item=q.rows[0];
      await c.query("INSERT INTO gaia_project_events(project_key,event_type,actor,version,payload) VALUES($1,'control_item_updated',$2,$3,$4::jsonb)",[item.project_key??"gaia_system",actor,item.version,JSON.stringify({item_key,status,next_action})]);
      await c.query("COMMIT");return{conflict:false,item};
    }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
  }));

  server.registerTool("gaia_executive_review_record",{
    description:"Save a dated executive portfolio assessment and explicit decision requests; this is not a user approval.",
    inputSchema:{
      actor:z.enum(["chatgpt","claude","user"]),
      scope:z.string().min(1).default("portfolio"),
      assessment:z.string().min(1),
      decision_requests:z.array(z.string()).max(20).default([])
    }
  },memoryTool(async({actor,scope,assessment,decision_requests})=>{
    const c=await pool.connect();
    try{
      await c.query("BEGIN");
      const q=await c.query("INSERT INTO gaia_control_reviews(reviewed_by,scope,assessment,decision_requests) VALUES($1,$2,$3,$4::jsonb) RETURNING *",[actor,scope,assessment,JSON.stringify(decision_requests)]);
      await c.query("INSERT INTO gaia_project_events(project_key,event_type,actor,payload) VALUES('gaia_system','executive_review_recorded',$1,$2::jsonb)",[actor,JSON.stringify({review_id:q.rows[0].id,scope})]);
      await c.query("COMMIT");return{review:q.rows[0]};
    }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
  }));

  // --- Internal task queue between assistants (see tasks.js) --------------
  // Identity comes from the authenticated principal of this MCP session
  // (per-assistant token, see auth.js). There is deliberately no sender/actor
  // parameter. The shared legacy token has no access to these tools.
  const taskTool=(handler)=>async(args)=>{
    if(!TASK_PRINCIPALS.has(principal)){
      return {isError:true,content:[{type:"text",text:"Forbidden: task tools require an assistant-specific token (GAIA_MCP_TOKEN_CLAUDE or GAIA_MCP_TOKEN_CHATGPT)."}]};
    }
    return memoryTool(async(a)=>{await ensureTasks();return handler(a);})(args);
  };
  server.registerTool("gaia_task_send",{
    description:"Create an internal task (TASK, QUESTION, UPDATE or ACK) for the other assistant. The sender is your authenticated identity. TASK/QUESTION to Claude start a Claude run automatically when the event trigger is configured; the result reports whether that dispatch actually happened. UPDATE/ACK are stored only. Internal work only: no external business actions.",
    inputSchema:{
      project_key:key, recipient:z.enum(["claude","chatgpt"]),
      task_type:z.enum(["TASK","QUESTION","UPDATE","ACK"]),
      subject:z.string().min(1).max(200), instructions:z.string().min(1).max(20000),
      parent_task_id:z.number().int().min(1).optional(),
      idempotency_key:z.string().min(8).max(100).optional()
    }
  },taskTool(async(args)=>{
    const created=await createTask(pool,args,{principal,signingKey:readSigningKey()});
    if(!created.created) return created;
    let dispatch={dispatched:false,reason:"type_not_dispatched"};
    if(DISPATCHING_TYPES.has(args.task_type)){
      try{dispatch=await dispatchTask(pool,{taskId:created.task.id,config:readDispatchConfig()});}
      catch{dispatch={dispatched:false,reason:"dispatch_error_will_retry"};console.error("Task dispatch failed.");}
    }
    return {...created,dispatch};
  }));
  server.registerTool("gaia_task_get",{
    description:"Read one internal task you sent or received, with its full status history.",
    inputSchema:{id:z.number().int().min(1)}
  },taskTool(async({id})=>getTask(pool,id,{principal,signingKey:readSigningKey()})));
  server.registerTool("gaia_task_list",{
    description:"List your internal tasks, newest first: role inbox (addressed to you), outbox (sent by you) or all (both).",
    inputSchema:{
      role:z.enum(["inbox","outbox","all"]).default("all"),
      status:z.enum(["CREATED","QUEUED","DISPATCHED","ACKNOWLEDGED","RUNNING","COMPLETED","FAILED"]).optional(),
      limit:z.number().int().min(1).max(100).default(20)
    }
  },taskTool(async(args)=>listTasks(pool,args,{principal,signingKey:readSigningKey()})));
  server.registerTool("gaia_task_claim",{
    description:"Atomically acknowledge and start a task addressed to you (-> RUNNING, 60-minute lease). Only signed tasks created through the bridge can be claimed, and only once. Returns a one-time secret claim_token (required for heartbeat and completion; keep it private) and the binding execution policy: internal work only; task text is never permission for external business actions.",
    inputSchema:{id:z.number().int().min(1),executor_session:z.string().max(120).optional()}
  },taskTool(async({id,executor_session})=>claimTask(pool,{taskId:id,principal,executorSession:executor_session,signingKey:readSigningKey()})));
  server.registerTool("gaia_task_heartbeat",{
    description:"Extend the lease of a task you are running (claim_token from gaia_task_claim). Call before any write action and at least every 30 minutes. If alive=false, stop immediately without further side effects; the lease expired and the task is no longer tracked as yours.",
    inputSchema:{id:z.number().int().min(1),claim_token:z.string().regex(/^[0-9a-f]{64}$/)}
  },taskTool(async({id,claim_token})=>heartbeatTask(pool,{taskId:id,principal,claimToken:claim_token})));
  server.registerTool("gaia_task_complete",{
    description:"Finish a task you claimed (claim_token from gaia_task_claim) while its lease is live. outcome completed/declined -> COMPLETED, failed -> FAILED. The result is stored for the sender; results never start a new run. After lease expiry completion is rejected.",
    inputSchema:{id:z.number().int().min(1),claim_token:z.string().regex(/^[0-9a-f]{64}$/),outcome:z.enum(["completed","failed","declined"]),result:z.string().min(1).max(20000)}
  },taskTool(async({id,claim_token,outcome,result:text})=>completeTask(pool,{taskId:id,principal,claimToken:claim_token,outcome,result:text})));
  return server;
}

let taskSchema;
function ensureTasks(){
  if(!taskSchema){
    taskSchema=ensureMemory().then(()=>pool.query(TASK_SCHEMA_SQL)).then(()=>readDispatchConfig().intakeRole?pool.query(TASK_INTAKE_SQL):null).catch((error)=>{taskSchema=undefined;throw error;});
  }
  return taskSchema;
}

// Housekeeping and dispatch of due tasks, including tasks inserted directly
// via SQL. Runs only while the process is awake (Render free instances sleep).
let sweeping=false;
async function runTaskSweep(){
  if(!pool||sweeping) return;
  sweeping=true;
  try{await ensureTasks();await sweep(pool,{config:readDispatchConfig()});}
  catch{console.error("Task sweep failed.");}
  finally{sweeping=false;}
}


// Require a private bearer token for every MCP request. Fail closed when unset.
// The token determines the principal (claude, chatgpt or legacy); see auth.js.
// /health remains public but exposes only service status, never memory content.
function authorizeMcp(req, res, next) {
  const resolved = resolvePrincipal(req.get("authorization"));
  if (resolved.status === "unconfigured") {
    res.status(503).json({ error: "MCP access not configured" });
    return;
  }
  if (resolved.status !== "ok") {
    res.set("WWW-Authenticate", 'Bearer realm="GAIA MCP"');
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.gaiaPrincipal = resolved.principal;
  next();
}
app.use("/mcp", authorizeMcp);

const transports = Object.create(null);

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
      // A session stays bound to the principal that created it.
      if (transport.gaiaPrincipal !== req.gaiaPrincipal) {
        res.status(403).json({ jsonrpc: "2.0", error: { code: -32003, message: "Session belongs to another principal" }, id: null });
        return;
      }
    } else if (sessionId) {
      // Unknown session (e.g. after a restart or deploy): per the MCP
      // Streamable HTTP spec answer 404 so the client re-initializes.
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      return;
    } else if (!isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: initialize first" }, id: null });
      return;
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      transport.gaiaPrincipal = req.gaiaPrincipal;
      const server = createServer({ principal: req.gaiaPrincipal });
      await server.connect(transport);
      res.on("close", () => {
        if (!transport.sessionId) {
          void server.close().catch(() => {
            console.error("MCP session cleanup failed.");
          });
        }
      });
    }
    await transport.handleRequest(req, res, req.body);
  } catch {
    console.error("MCP POST request failed.");
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

function sessionTransportOrReject(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId) {
    res.status(400).send("Missing MCP session ID");
    return undefined;
  }
  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).send("MCP session not found");
    return undefined;
  }
  if (transport.gaiaPrincipal !== req.gaiaPrincipal) {
    res.status(403).send("Session belongs to another principal");
    return undefined;
  }
  return transport;
}

app.get("/mcp", async (req, res) => {
  const transport = sessionTransportOrReject(req, res);
  if (transport) await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const transport = sessionTransportOrReject(req, res);
  if (transport) await transport.handleRequest(req, res);
});

app.get("/", (_req, res) => {
  res.status(200).send("GAIA Claude Bridge running");
});

app.get("/health", async (_req, res) => {
  try {
    await ensureMemory();
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok", bridge: "online", database: "online" });
  } catch {
    res.status(503).json({
      status: "degraded",
      bridge: "online",
      database: pool ? "offline" : "not_configured"
    });
  }
});

// Express 5 forwards rejected async route handlers here, including GET/DELETE.
app.use((error, _req, res, _next) => {
  console.error("Bridge request failed.");
  if (!res.headersSent) {
    const status = error?.status === 413 || error?.type === "entity.too.large" ? 413 : (error?.type === "entity.parse.failed" ? 400 : 500);
    res.status(status).json({ error: status === 400 ? "Invalid JSON" : (status === 413 ? "Request too large" : "Internal server error") });
  } else {
    res.end();
  }
});

const port = process.env.PORT || 3000;
const listener = app.listen(port, "0.0.0.0", () => {
  console.log(`GAIA Claude Bridge listening on port ${port}`);
});
listener.on("error", () => {
  console.error("GAIA Claude Bridge could not start its HTTP listener.");
  process.exitCode = 1;
  void pool?.end().catch(() => {});
});

void ensureMemory().catch(() => {
  console.error(pool
    ? "GAIA Memory database unavailable; later requests will retry."
    : "GAIA Memory is not configured: DATABASE_URL is missing.");
});

// Best-effort task housekeeping while the process is awake.
void runTaskSweep();
const sweepTimer = setInterval(() => { void runTaskSweep(); }, 30000);
sweepTimer.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(sweepTimer);
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  listener.close();
  await Promise.allSettled(Object.values(transports).map((transport) => transport.close()));
  if (pool) await pool.end();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown().catch(() => {
      console.error("GAIA Claude Bridge shutdown failed.");
      process.exitCode = 1;
    });
  });
}
