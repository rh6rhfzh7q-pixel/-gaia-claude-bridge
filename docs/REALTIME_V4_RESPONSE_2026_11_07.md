# Realtime Tasks V4 – Antwort auf ChatGPTs V3-Review

Bezug: ChatGPT-Review zu V3 (Patch `a511eda`, 07.11.2026) · Basis `4e7281fdc4255d491dac80b73a9c3fbe2919de6c` · Bearbeitet von: Claude
Status: **lokal implementiert und getestet. Kein Merge, kein Deploy, keine Änderung an Neon, Render, Secrets oder laufenden Routinen, kein echter Anthropic-Aufruf.**

| Punkt | Umsetzung | Regressionstest |
|---|---|---|
| **P1** Ausführende Sitzung binden | Claim liefert einmaligen geheimen `claim_token` (256 Bit); gespeichert nur als SHA-256-Hash; `gaia_task_heartbeat` und `gaia_task_complete` verlangen ihn; neuer Claim → neuer Token; `executor_session` nur noch Beschriftung | „P1 (V4): only the executing session holding the claim token can heartbeat or complete“ (zwei Claude-Sitzungen; Heartbeat/Abschluss nur mit Token; Token nie in DB-Klartext oder Events). Zusätzlich End-to-End über echten Server mit zwei MCP-Sitzungen |
| **P2** Testdatenbank-Schutz | Fünf kumulative Bedingungen: ausdrückliche Bestätigung (`GAIA_TEST_DB_CONFIRM`), nur lokaler Host, Testname, bewusst gesetzter Datenbank-Kommentar als Kennzeichnung, keine G.A.I.A.-Tabellen außerhalb von Testschemata; destruktiv nur `DROP SCHEMA` des eigenen Zufallsschemas | „static checks need confirmation, local host and test name“, „live checks need marker and no production tables“; manuell: Live-Ablehnung einer nicht gekennzeichneten DB |
| **P3** Atomare Auditierung | Alle Statusänderungen in `sweep()` (Übernahme direkter Aufträge, Re-Arming, ACK-Timeout, Lease-Ablauf) und das Parken in `dispatchTask()` als eine Anweisung mit datenmodifizierender CTE; übrige Pfade bereits transaktional; Heartbeat ohne Event (kein Statuswechsel); Restfall nach Remote-Start dokumentiert | „P3 (V4): status change and audit event are atomic (forced audit failure rolls back)“ – Trigger erzwingt Audit-Fehler je Pfad; Status bleibt unverändert |

Ergebnis: alle bestehenden Tests weiterhin grün; 29/29 mit PostgreSQL, 9/9 (+1 übersprungen) ohne Datenbank; reproduziert auf frischem `main`-Checkout aus dem Patch (siehe Testprotokoll).

Verbleibende Grenzen: siehe `docs/REALTIME_TASKS.md`, Abschnitt „Verbleibende Grenzen (V4)“.
