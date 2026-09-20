import express from "express";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const { Pool } = pg;
const app = express();
app.use(express.json());

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not configured.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});

async function ensureSchema() {
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
  await pool.query("CREATE INDEX IF NOT EXISTS gaia_memory_updated_at_idx ON gaia_memory (updated_at DESC)");
}

const schemaReady = ensureSchema().catch((error) => {
  console.error("Database initialization failed:", error.message);
  throw error;
});

function textResult(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function safeError(prefix, error) {
  console.error(prefix, error?.message || error);
  return textResult(`${prefix}. Database operation failed.`);
}

function createServer() {
  const server = new McpServer({ name: "gaia-claude-bridge", version: "1.1.0" });

  server.registerTool("gaia_status", {
    description: "Check whether the GAIA Claude Bridge is operational."
  }, async () => textResult("GAIA Claude Bridge is operational."));

  server.registerTool("gaia_memory_status", {
    description: "Check whether the GAIA persistent PostgreSQL memory is connected."
  }, async () => {
    try {
      await schemaReady;
      const { rows } = await pool.query("SELECT COUNT(*)::int AS entries FROM gaia_memory");
      return textResult({ status: "connected", entries: rows[0].entries });
    } catch (error) {
      return safeError("GAIA Memory is unavailable", error);
    }
  });

  server.registerTool("gaia_memory_get", {
    description: "Get one persistent GAIA memory entry by namespace and key.",
    inputSchema: {
      namespace: z.string().min(1).default("gaia"),
      key: z.string().min(1)
    }
  }, async ({ namespace = "gaia", key }) => {
    try {
      await schemaReady;
      const { rows } = await pool.query(
        "SELECT namespace, key, content, metadata, created_at, updated_at FROM gaia_memory WHERE namespace = $1 AND key = $2",
        [namespace, key]
      );
      return textResult(rows[0] ?? { found: false, namespace, key });
    } catch (error) {
      return safeError("Unable to read GAIA Memory", error);
    }
  });

  server.registerTool("gaia_memory_search", {
    description: "Search persistent GAIA memory by text within key or content.",
    inputSchema: {
      query: z.string().min(1),
      namespace: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).default(20)
    }
  }, async ({ query, namespace, limit = 20 }) => {
    try {
      await schemaReady;
      const pattern = `%${query}%`;
      const params = namespace ? [namespace, pattern, limit] : [pattern, limit];
      const sql = namespace
        ? "SELECT namespace, key, content, metadata, created_at, updated_at FROM gaia_memory WHERE namespace = $1 AND (key ILIKE $2 OR content ILIKE $2) ORDER BY updated_at DESC LIMIT $3"
        : "SELECT namespace, key, content, metadata, created_at, updated_at FROM gaia_memory WHERE key ILIKE $1 OR content ILIKE $1 ORDER BY updated_at DESC LIMIT $2";
      const { rows } = await pool.query(sql, params);
      return textResult({ count: rows.length, results: rows });
    } catch (error) {
      return safeError("Unable to search GAIA Memory", error);
    }
  });

  server.registerTool("gaia_memory_upsert", {
    description: "Create or update one persistent GAIA memory entry.",
    inputSchema: {
      namespace: z.string().min(1).default("gaia"),
      key: z.string().min(1),
      content: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({})
    }
  }, async ({ namespace = "gaia", key, content, metadata = {} }) => {
    try {
      await schemaReady;
      const { rows } = await pool.query(
        `INSERT INTO gaia_memory (namespace, key, content, metadata)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (namespace, key)
         DO UPDATE SET content = EXCLUDED.content, metadata = EXCLUDED.metadata, updated_at = NOW()
         RETURNING namespace, key, content, metadata, created_at, updated_at`,
        [namespace, key, content, JSON.stringify(metadata)]
      );
      return textResult(rows[0]);
    } catch (error) {
      return safeError("Unable to write GAIA Memory", error);
    }
  });

  return server;
}

const transports = {};

app.get("/health", async (_req, res) => {
  try {
    await schemaReady;
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports[id] = transport; }
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      const server = createServer();
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP POST error:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/mcp", async (req, res) => {
  const transport = transports[req.headers["mcp-session-id"]];
  if (!transport) return res.status(400).send("Invalid or missing MCP session ID");
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const transport = transports[req.headers["mcp-session-id"]];
  if (!transport) return res.status(400).send("Invalid or missing MCP session ID");
  await transport.handleRequest(req, res);
});

app.get("/", (_req, res) => res.status(200).send("GAIA Claude Bridge running"));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log(`GAIA Claude Bridge listening on port ${port}`));
