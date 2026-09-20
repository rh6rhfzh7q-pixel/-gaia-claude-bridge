# GAIA Claude Bridge

An Express MCP bridge with persistent PostgreSQL memory.

## Run

Use Node.js 18 or later. Install dependencies with `npm install`, then run
`npm start`. The HTTP listener uses `PORT` (default 3000).

Configure `DATABASE_URL` in the hosting environment. Never commit a connection
string or print it in logs. The existing Render environment variable can be
used as-is. PostgreSQL TLS settings follow the connection string and pg defaults.

At startup the bridge creates `gaia_memory` and its updated-at index if absent.
The database role needs permission to create the table/index and read/write
rows. Failed initialization is retried by the next health check or memory call.
A missing or unavailable database does not prevent the HTTP bridge from starting.
Connection and query timeouts keep database failures bounded.

- `GET /`: bridge liveness, HTTP 200.
- `GET /health`: table initialization and PostgreSQL `SELECT 1`; HTTP 200
  when ready, HTTP 503 otherwise. Responses never include driver errors.
- `POST/GET/DELETE /mcp`: existing stateful Streamable HTTP MCP transport.

## Tools

| Tool | Inputs | Result |
| --- | --- | --- |
| gaia_status | none | Bridge availability |
| gaia_memory_status | none | Database availability and total row count (decimal string) |
| gaia_memory_get | key, namespace? | Exact entry or `memory: null` |
| gaia_memory_search | namespace?, query?, limit? | Entries ordered by updated_at descending |
| gaia_memory_upsert | key, content, namespace?, metadata? | Created/updated entry |

Namespace defaults to `gaia`. Search limit defaults to 20 and must be an integer
from 1 to 100. Search matches key/content with ILIKE; PostgreSQL wildcard
characters `%` and `_` in the query retain their wildcard meaning.
All user values are passed as SQL parameters.

Upserts preserve the entry ID and created_at, and update updated_at. Metadata
must be a JSON object; omission replaces it with an empty object. BIGSERIAL IDs
are returned as strings to preserve precision. Database failures return MCP
`isError: true` with a sanitized message.

Namespaces organize data; they do not enforce authorization. The bridge retains
its existing access model: clients with MCP access can read and write memory.

## Tests

`npm test` exercises real HTTP/MCP sessions with missing, unreachable, and
malformed database configuration, including input validation and sanitized errors.

For PostgreSQL integration tests, set `TEST_DATABASE_URL` to an isolated test
database and run `npm test`. These tests create the schema if absent, verify
upserts, namespace isolation, parameterized quote handling, case-insensitive
search, persistence across bridge restarts, and recovery after a temporary
connection failure. They clean up only their uniquely named test entries.
Without that variable the integration tests are skipped. Do not use a production
database for tests.

The test suite never inherits `DATABASE_URL` into its spawned bridges.
