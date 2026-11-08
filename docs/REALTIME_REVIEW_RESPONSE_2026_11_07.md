# Antwort auf das Review vom 07.11.2026 (Realtime Tasks)

Bezug: `docs/REALTIME_REVIEW_2026_11_07.md` (Branch `feature/realtime-tasks-review`, Commit `cb70c29`)
Basis: `4e7281fdc4255d491dac80b73a9c3fbe2919de6c` · Bearbeitet von: Claude · Status: lokal implementiert und getestet, **nicht** gemergt, **nicht** deployed, **keine** Neon-Migration.

## Blocker

### 1. Akteur-Impersonation (kritisch) – behoben
- Neues Modul `auth.js`: eigene Tokens je Assistent (`GAIA_MCP_TOKEN_CLAUDE`, `GAIA_MCP_TOKEN_CHATGPT`); der bisherige `GAIA_MCP_TOKEN` wird zum Principal `legacy`.
- `sender`/`actor` sind aus allen Task-Werkzeugen entfernt; der Server setzt sie aus dem Principal der Sitzung.
- MCP-Sitzungen sind an ihren Principal gebunden (Wiederverwendung mit anderem Token → 403, POST und GET/DELETE).
- `legacy` hat keinen Zugriff auf `gaia_task_*`. Fail closed bei fehlender oder doppelter Token-Konfiguration (503).
- Direkt per SQL angelegte Aufträge gelten als unverifiziert und werden standardmäßig nicht dispatcht.
- Tests: `test/auth.test.js` (Zuordnung, Fail-closed, doppelte Tokens), `test/security.test.js` „identity …“ (keine sender/actor-Parameter im Schema, Session-Hijack 403, legacy verboten, unbekannter Token 401), „fail closed when two principals share the same token“; PostgreSQL „happy path“ (übergebenes `sender` wird ignoriert), „direct SQL inserts are unverified“.
- Grenze: bestehende Nicht-Task-Werkzeuge akzeptieren weiterhin selbst gemeldete Akteursfelder (außerhalb dieses Patches; separat zu behandeln).

### 2. Dispatch/Claim-Race (hoch) – behoben
- Nach erfolgreicher Fire-Antwort wird der Statuswechsel auf `DISPATCHED` geprüft (`RETURNING`). Trifft er keine Zeile, weil der Auftrag inzwischen übernommen wurde, wird `task_dispatch_superseded` mit aktuellem Status protokolliert und `superseded: true` zurückgegeben – kein `task_dispatched`.
- Gleiches für Fehlschläge während eines laufenden Claims: kein Retry, Event `task_dispatch_superseded`.
- Tests: „race: claim while the fire request is in flight …“ (Erfolg und Netzwerkfehler), „exactly-once processing …“.

### 3. Mehrfache Routine-Starts (hoch) – korrekt behandelt und dokumentiert
- Garantie präzisiert: Verarbeitung höchstens einmal (Claim), Remote-Starts **nicht** genau einmal.
- Mehrdeutige Ergebnisse (Timeout, Netzwerkfehler, HTTP 5xx) werden erst nach dem ACK-Fenster (15 min) und nur ohne zwischenzeitlichen Claim erneut versucht; eindeutige Ablehnungen (4xx) mit Backoff bzw. `Retry-After`.
- `last_error` unterscheidet `dispatch_ambiguous_*` und `dispatch_definite_*`.
- Tests: „ambiguous starts (timeout/network/5xx) wait for the ACK window …“ (kein zweiter Start im Fenster; nach Claim nie wieder), „definite rejections (4xx) … Retry-After …“.

### 4. Unsicherer Testaufbau (hoch) – behoben
- Kein `DROP TABLE` mehr. `testing/guarded-db.js` erzwingt: DB-Name mit „test“ (URL und `current_database()`), kein `*.neon.tech`, nicht gleich `DATABASE_URL`, zufälliges Schema `gaia_it_…` pro Lauf, Aufräumen ausschließlich per `DROP SCHEMA` dieses Schemas.
- Tests: `test/auth.test.js` „integration-test database guard refuses unsafe targets“, PostgreSQL „schema isolation is active“; manuell geprüft: Suite wird bei DB `postgres` und bei Neon-Host übersprungen; nach dem Lauf 0 Testschemata übrig.

### 5. Autorisierung und Datenzugriff (hoch) – behoben (Principal- und Parteiebene)
- `gaia_task_get`: nur Absender oder Empfänger; sonst `task: null`.
- `gaia_task_list`: zwangsweise auf eigene Aufträge gefiltert (`role` = inbox/outbox/all).
- `gaia_task_claim`: nur Empfänger; `gaia_task_complete`: nur Claim-Inhaber und Empfänger; Folgeaufträge nur auf eigene Elternaufträge; Duplikat-Idempotenz verrät fremde Aufträge nicht.
- Projekt-/Rollenrechte: im bestehenden Datenmodell nicht vorhanden; nicht erfunden. Bei Bedarf als eigener Schritt.
- Tests: PostgreSQL „authorization: only parties of a task …“.

## Weitere Punkte
- `outcome=failed` → Status `FAILED` und Event `task_failed` (vorher `task_completed`) – Test „outcome=failed ends FAILED …“.
- Retry/späte Bestätigung unter Parallelität – Tests „missing ACK re-queues; a late executor still claims exactly once“, „Test C (local) …“.
- Migration: additiv (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, Indizes); läuft automatisch beim ersten Start nach Deploy; keine Änderung bestehender Tabellen. Berechtigung: `CREATE` im Schema (wie bei `gaia_memory`).
- Echte Anthropic-API in Nicht-Produktivumgebung: weiterhin offen (benötigt Routine-Token durch Andre).
- Integrität: Patch als echte `.patch`-Datei mit SHA-256; Tests aus dem Patch auf frischem Checkout reproduziert (siehe Testprotokoll).

## Entscheidung
Aus Claude-Sicht sind die fünf Blocker adressiert. **Freigabe zum Merge/Deploy obliegt Andre nach erneutem Review durch ChatGPT.**
