// Guarded, isolated PostgreSQL access for integration tests.
//
// Destructive integration tests run only when ALL of the following hold
// (a matching database name alone is never sufficient):
//
// Static checks (before connecting):
//  1. GAIA_TEST_DATABASE_URL is set and is a postgres URL.
//  2. Explicit confirmation: GAIA_TEST_DB_CONFIRM=disposable-local-database.
//  3. The host is local: localhost, 127.0.0.1, ::1 or a Unix socket directory.
//     Remote hosts (including any *.neon.tech) are always refused.
//  4. The database name contains "test" and differs from DATABASE_URL.
//
// Live checks (on the connection, before anything is created):
//  5. current_database() contains "test".
//  6. The database carries the disposable marker, set once by a human:
//       COMMENT ON DATABASE <name> IS 'gaia-disposable-test-database';
//  7. No G.A.I.A. production table exists in any schema outside gaia_it_*.
//
// Isolation: every run creates its own random schema gaia_it_<hex>. The only
// destructive statement is DROP SCHEMA of exactly that schema, re-checked
// against the name pattern and the run's own name before execution.
import pg from "pg";
import { randomBytes } from "node:crypto";

export const CONFIRM_VALUE = "disposable-local-database";
export const DATABASE_MARKER = "gaia-disposable-test-database";
export const PRODUCTION_TABLES = [
  "gaia_memory", "gaia_project_state", "gaia_project_events", "gaia_project_messages",
  "gaia_control_items", "gaia_control_reviews", "gaia_tasks"
];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SCHEMA_PATTERN = /^gaia_it_[0-9a-f]{12}$/;

export function testDatabaseUrlProblem(env = process.env) {
  const url = env.GAIA_TEST_DATABASE_URL;
  if (!url) return "GAIA_TEST_DATABASE_URL not set";
  if (env.GAIA_TEST_DB_CONFIRM !== CONFIRM_VALUE) {
    return `explicit confirmation missing: set GAIA_TEST_DB_CONFIRM=${CONFIRM_VALUE}`;
  }
  let parsed;
  try { parsed = new URL(url); } catch { return "GAIA_TEST_DATABASE_URL is not a valid URL"; }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return "GAIA_TEST_DATABASE_URL must be a postgres URL";
  const socketHost = parsed.searchParams.get("host");
  const host = parsed.hostname.toLowerCase();
  const isLocal = socketHost ? socketHost.startsWith("/") && (host === "" || LOCAL_HOSTS.has(host)) : LOCAL_HOSTS.has(host);
  if (!isLocal) return `refusing non-local database host "${socketHost || host}"`;
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/test/i.test(dbName)) return `refusing database "${dbName}": name must contain "test"`;
  if (env.DATABASE_URL && env.DATABASE_URL === url) return "GAIA_TEST_DATABASE_URL must not equal DATABASE_URL";
  return null;
}

export async function liveDatabaseProblem(client) {
  const { rows } = await client.query(
    `SELECT current_database() AS db,
            shobj_description((SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database') AS marker`
  );
  if (!/test/i.test(rows[0].db)) return `refusing live database "${rows[0].db}"`;
  if (rows[0].marker !== DATABASE_MARKER) {
    return `database "${rows[0].db}" lacks the disposable marker (COMMENT ON DATABASE ... IS '${DATABASE_MARKER}')`;
  }
  const prod = await client.query(
    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = ANY($1) AND table_schema NOT LIKE 'gaia\\_it\\_%'",
    [PRODUCTION_TABLES]
  );
  if (prod.rows.length) {
    const found = prod.rows.map((r) => `${r.table_schema}.${r.table_name}`).join(", ");
    return `refusing database containing G.A.I.A. tables outside test schemas: ${found}`;
  }
  return null;
}

export async function openIsolatedSchema(env = process.env) {
  const problem = testDatabaseUrlProblem(env);
  if (problem) throw new Error(problem);
  const schema = "gaia_it_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: env.GAIA_TEST_DATABASE_URL });
  await admin.connect();
  try {
    const live = await liveDatabaseProblem(admin);
    if (live) throw new Error(live);
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: env.GAIA_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const { rows } = await pool.query("SELECT current_schema() AS s");
  if (rows[0].s !== schema) {
    await pool.end();
    throw new Error("isolated schema not active; aborting");
  }
  return {
    pool,
    schema,
    async close() {
      await pool.end();
      if (!SCHEMA_PATTERN.test(schema)) throw new Error("refusing to drop unexpected schema");
      const cleanup = new pg.Client({ connectionString: env.GAIA_TEST_DATABASE_URL });
      await cleanup.connect();
      try { await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await cleanup.end(); }
    }
  };
}
