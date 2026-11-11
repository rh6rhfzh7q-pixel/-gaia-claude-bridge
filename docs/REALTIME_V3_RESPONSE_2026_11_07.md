# Realtime Tasks V3 – Bearbeitung von Issue #6

Bezug: Issue #6 „Realtime Tasks V2: final security fixes and acceptance criteria“ und `docs/REALTIME_V2_REVIEW_2026_11_07.md` (Branch `feature/realtime-tasks-review`, Commit `2451fd7`)
Basis: `4e7281fdc4255d491dac80b73a9c3fbe2919de6c` · Bearbeitet von: Claude · Stand 07.11.2026
Status: **lokal implementiert und getestet. Nicht gemergt, nicht deployed, keine Neon-Migration, keine Änderung an Render-Secrets, kein echter Anthropic-Aufruf.**

## Issue #6 – Punkt für Punkt

| # | Anforderung | Umsetzung | Nachweis (Test) |
|---|---|---|---|
| 1 | Unverifizierte Aufträge weder auslösen noch übernehmen | HMAC-SHA256-Signatur je Auftrag (`GAIA_TASK_SIGNING_KEY`); Dispatch **und** Claim verlangen gültige Signatur; SQL-Zeilen und manipulierte Zeilen sichtbar, aber nie ausführbar; fail closed ohne Schlüssel; Opt-in `GAIA_DISPATCH_UNVERIFIED` entfernt | „P1: unsigned tasks are visible but never dispatched or claimed“ (inkl. Fälschung mit gesetzten Verifizierungsfeldern), „P1: signed tasks claim; tampering after signing breaks executability“ |
| 2 | Freigabegrenze für externe Geschäftshandlungen im Executor | `execution_scope='internal_only'` (DB-CHECK); Claim liefert verbindliche `EXECUTION_POLICY`; Routine-Anweisung entsprechend; Empfehlung: Routine nur mit Connector „GAIA Secure Bridge“. **Grenze dokumentiert:** Code kann eigene Werkzeuge eines Executors nicht sperren | „P2: claim returns the binding internal-only policy; scope cannot be widened“ |
| 3 | RUNNING-Timeout = Ende der Nachverfolgung, kein Abbruch; Wiederaufnahmeregeln | Lease 60 min, `gaia_task_heartbeat`; Ablauf → `FAILED`/`tracking_lease_expired`; Heartbeat danach `alive=false` + `stop_without_side_effects`; späte Abschlüsse abgewiesen und auditiert; keine automatische Neuauflage, neuer Auftrag mit neuem Schlüssel | „P3: lease expiry ends tracking, rejects late completion, heartbeat tells executor to stop“ |
| 4 | Parallele doppelte Idempotenzschlüssel | `INSERT … ON CONFLICT (idempotency_key) DO NOTHING` + Nachlesen | „P4: concurrent requests with the same idempotency key → one task, no errors“ (8 parallele Anfragen) |
| 5 | `@hono/node-server`-Advisory | GHSA-rmxm-3fg6-px4f betrifft `serveStatic`; die Bridge nutzt das Paket nur indirekt über das MCP-SDK (`getRequestListener`) → nach Prüfung nicht ausnutzbar. Trotzdem behoben: 2.1.1 → 2.1.6 nur in `package-lock.json`; `npm audit` = 0 | Testprotokoll Abschnitt „npm audit“ |
| 6 | Original-Patch, Testprotokoll, SHA-256; echter Trigger nur nach Freigabe in Nicht-Produktion | Patch als `git format-patch`, Testprotokoll vom frischen Checkout, Prüfsummendatei | siehe Übergabe |

Zusätzlich aus dem Review (P2 „legacy tools“): Mit Claude-/ChatGPT-Token müssen `actor`/`sender`/`recipient` der bestehenden Werkzeuge dem Principal entsprechen (Test „identity …“). Der Legacy-Token verhält sich unverändert, bis er abgeschaltet wird.

## Funktionsstand – ausdrücklich getrennt

**Technisch funktionierend (lokal nachgewiesen, Tests gegen PostgreSQL 17.5 und echten Serverprozess):**
- Auftragswarteschlange mit Statuskette, Typen, Signatur, Policy, Lease, Idempotenz, Retry, Autorisierung.
- Identität je Assistent, Sitzungsbindung, Identitätsbindung der bestehenden Werkzeuge.
- Claude → ChatGPT **als Ablage**: Claude legt Aufträge/Ergebnisse an; ChatGPT liest sie bei seinem nächsten Lauf (direkt in Neon oder über die Bridge).
- ChatGPT → Claude **als Ablage**: ChatGPT legt über die Bridge (eigener Token) signierte Aufträge an; Claude liest sie beim Vierfach-Sync oder in aktiver Sitzung.

**Implementiert, aber nicht produktiv nachgewiesen (benötigt externe Schritte):**
- Automatischer Claude-Start über die Anthropic-Routine-Fire-API: Code und Mock-Tests fertig; echter Aufruf erst nach Deploy, Token-Erzeugung durch Andre und gesonderter Testfreigabe.

**Nicht implementiert:**
- Automatischer ChatGPT-Start. Ein unterstützter externer Startmechanismus für ChatGPT ist nicht nachgewiesen. Richtung Claude → ChatGPT bleibt bis dahin abhängig vom ChatGPT-Sync.

## Bekannte Restgrenzen
- Direkte SQL-Aufträge von ChatGPT sind bewusst **nicht** ausführbar. Für automatische Beauftragung muss ChatGPT die Bridge mit eigenem Token nutzen (MCP).
- Render Free schläft bei Inaktivität; Kaltstart verzögert die erste Verarbeitung.
- Policy-Durchsetzung beim Executor ist organisatorisch/konfigurativ, nicht kryptografisch.
- Ein Wechsel von `GAIA_TASK_SIGNING_KEY` macht offene Aufträge nicht mehr ausführbar (gewollt; vor Wechsel offene Aufträge abschließen).
