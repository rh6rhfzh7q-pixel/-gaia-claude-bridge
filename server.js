import express from "express";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json());

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

function createServer() {
  const server = new McpServer({
    name: "gaia-claude-bridge",
    version: "1.0.0"
  });
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
  return server;
}

const transports = Object.create(null);

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
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
      const server = createServer();
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

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing MCP session ID");
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing MCP session ID");
    return;
  }
  await transport.handleRequest(req, res);
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
    const status = error?.type === "entity.parse.failed" ? 400 : 500;
    res.status(status).json({ error: status === 400 ? "Invalid JSON" : "Internal server error" });
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

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
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
