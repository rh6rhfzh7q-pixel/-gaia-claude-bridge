#!/usr/bin/env node
// Private, local-only PostgreSQL backup. Never commit backup files or connection strings.
import { spawn } from "node:child_process";
import { mkdir, chmod, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";

const raw = process.env.GAIA_BACKUP_DATABASE_URL;
if (!raw) {
  console.error("Set GAIA_BACKUP_DATABASE_URL locally to the Render External Database URL.");
  process.exit(2);
}
let url;
try { url = new URL(raw); } catch { console.error("Invalid database URL."); process.exit(2); }
if (!["postgres:", "postgresql:"].includes(url.protocol)) {
  console.error("Expected a PostgreSQL connection URL."); process.exit(2);
}
const dir = resolve("backups");
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const filename = `gaia-memory-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`;
const file = resolve(dir, filename);
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
  PGSSLMODE: url.searchParams.get("sslmode") || "require",
};
const child = spawn("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", file], {
  env, stdio: ["ignore", "ignore", "pipe"]
});
let stderr = "";
child.stderr.on("data", b => { stderr += b.toString(); });
child.on("error", () => { console.error("pg_dump not installed or cannot start."); process.exitCode = 1; });
const code = await new Promise(done => child.on("close", done));
if (code !== 0) {
  // Avoid printing driver errors: connection strings or credentials can appear in errors.
  console.error("Backup failed. Check PostgreSQL client installation, IP allowlist and SSL connection.");
  process.exit(1);
}
const size = (await stat(file)).size;
if (!size) { console.error("Empty backup file."); process.exit(1); }
const verify = spawn("pg_restore", ["--list", file], { stdio: ["ignore", "pipe", "ignore"] });
let listing = "";
verify.stdout.on("data", b => { listing += b.toString(); });
const verified = await new Promise(done => verify.on("close", done));
if (verified !== 0 || !listing.includes("gaia_memory")) {
  console.error("Backup verification failed."); process.exit(1);
}
await chmod(file, 0o600);
console.log(`Verified local backup: ${file} (${size} bytes). Keep it private.`);
