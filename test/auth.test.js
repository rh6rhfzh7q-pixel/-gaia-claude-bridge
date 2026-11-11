import test from "node:test";
import assert from "node:assert/strict";
import { readPrincipalTokens, resolvePrincipal } from "../auth.js";
import { CONFIRM_VALUE, DATABASE_MARKER, PRODUCTION_TABLES, liveDatabaseProblem, testDatabaseUrlProblem } from "../testing/guarded-db.js";

const C = "claude-token-".padEnd(40, "C");
const G = "chatgpt-token-".padEnd(40, "G");
const L = "legacy-token-".padEnd(40, "L");
const env = { GAIA_MCP_TOKEN_CLAUDE: C, GAIA_MCP_TOKEN_CHATGPT: G, GAIA_MCP_TOKEN: L };

test("each token maps to exactly one server-side principal", () => {
  assert.deepEqual(resolvePrincipal("Bearer " + C, env), { status: "ok", principal: "claude" });
  assert.deepEqual(resolvePrincipal("Bearer " + G, env), { status: "ok", principal: "chatgpt" });
  assert.deepEqual(resolvePrincipal("Bearer " + L, env), { status: "ok", principal: "legacy" });
  assert.equal(resolvePrincipal("Bearer wrong", env).status, "unauthorized");
  assert.equal(resolvePrincipal(undefined, env).status, "unauthorized");
  assert.equal(resolvePrincipal(C, env).status, "unauthorized", "Bearer prefix required");
});

test("fail closed: nothing configured, short tokens, or duplicate tokens", () => {
  assert.equal(resolvePrincipal("Bearer " + C, {}).status, "unconfigured");
  assert.equal(readPrincipalTokens({ GAIA_MCP_TOKEN_CLAUDE: "short" }).ok, false);
  const dup = { GAIA_MCP_TOKEN_CLAUDE: C, GAIA_MCP_TOKEN_CHATGPT: C };
  assert.equal(readPrincipalTokens(dup).reason, "duplicate_tokens");
  assert.equal(resolvePrincipal("Bearer " + C, dup).status, "unconfigured");
});

test("legacy single-token setups keep working", () => {
  assert.deepEqual(resolvePrincipal("Bearer " + L, { GAIA_MCP_TOKEN: L }), { status: "ok", principal: "legacy" });
});

test("integration-test database guard: static checks need confirmation, local host and test name", () => {
  const ok = { GAIA_TEST_DB_CONFIRM: CONFIRM_VALUE };
  assert.match(testDatabaseUrlProblem({}), /not set/);
  assert.match(testDatabaseUrlProblem({ GAIA_TEST_DATABASE_URL: "postgres://u:p@127.0.0.1/gaia_test" }), /explicit confirmation missing/,
    "a matching name alone is not enough");
  assert.match(testDatabaseUrlProblem({ ...ok, GAIA_TEST_DATABASE_URL: "postgres://u:p@localhost/gaia" }), /must contain "test"/);
  assert.match(testDatabaseUrlProblem({ ...ok, GAIA_TEST_DATABASE_URL: "postgres://u:p@ep-x.eu-central-1.aws.neon.tech/gaia_test" }), /non-local/);
  assert.match(testDatabaseUrlProblem({ ...ok, GAIA_TEST_DATABASE_URL: "postgres://u:p@db.internal.example/gaia_test" }), /non-local/);
  assert.match(testDatabaseUrlProblem({ ...ok, GAIA_TEST_DATABASE_URL: "postgres://u:p@10.0.0.5/gaia_test" }), /non-local/);
  assert.match(testDatabaseUrlProblem({ ...ok, GAIA_TEST_DATABASE_URL: "mysql://u:p@127.0.0.1/gaia_test" }), /postgres URL/);
  const same = "postgres://u:p@localhost/gaia_test";
  assert.match(testDatabaseUrlProblem({ ...ok, GAIA_TEST_DATABASE_URL: same, DATABASE_URL: same }), /must not equal/);
  assert.equal(testDatabaseUrlProblem({ ...ok, GAIA_TEST_DATABASE_URL: "postgres://u:p@127.0.0.1:5432/gaia_test" }), null);
  assert.equal(testDatabaseUrlProblem({ ...ok, GAIA_TEST_DATABASE_URL: "postgres://u:p@localhost/gaia_test?host=/var/run/postgresql" }), null);
});

function fakeClient({ db = "gaia_disposable_test", marker = DATABASE_MARKER, tables = [] } = {}) {
  return {
    async query(sql) {
      if (/current_database/.test(sql)) return { rows: [{ db, marker }] };
      return { rows: tables.map(([table_schema, table_name]) => ({ table_schema, table_name })) };
    }
  };
}

test("integration-test database guard: live checks need marker and no production tables", async () => {
  assert.equal(await liveDatabaseProblem(fakeClient()), null);
  assert.match(await liveDatabaseProblem(fakeClient({ db: "neondb" })), /refusing live database/);
  assert.match(await liveDatabaseProblem(fakeClient({ marker: null })), /lacks the disposable marker/);
  assert.match(await liveDatabaseProblem(fakeClient({ marker: "something else" })), /lacks the disposable marker/);
  assert.match(await liveDatabaseProblem(fakeClient({ tables: [["public", "gaia_memory"]] })), /G\.A\.I\.A\. tables outside test schemas: public\.gaia_memory/);
  assert.equal(PRODUCTION_TABLES.includes("gaia_project_events"), true);
});
