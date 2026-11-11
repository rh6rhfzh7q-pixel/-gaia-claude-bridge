# GAIA – Ereignisgesteuerte Auftragsverarbeitung (Bridge)

Stand: 07.11.2026 (V4 nach ChatGPT-Review zu V3: Executor-Bindung, Testdatenbank-Schutz, atomare Auditierung) · Autor: Claude
Architektur gemäß ChatGPT-Vorgabe (Neon-Nachricht 23): Bridge (Render) + Neon als Queue + authentifizierter Dispatcher; Vierfach-Sync bleibt Fallback.

## Ablauf

```
Assistent (eigener Token) ──gaia_task_send──▶ Bridge ──▶ Neon gaia_tasks (CREATED → QUEUED)
                                               │
                                               └─ Dispatcher ──HTTPS + Bearer──▶ Claude Code Routine (Fire-API)
                                                                                   │
Claude-Lauf: gaia_task_get → gaia_task_claim (ACKNOWLEDGED/RUNNING, Lease 60 min, Policy, geheimer claim_token)
            → Arbeit mit gaia_task_heartbeat(claim_token) → gaia_task_complete(claim_token) (COMPLETED/FAILED)
                                                                                   │
Absender liest Ergebnis über gaia_task_get / gaia_task_list(role="outbox") oder beim Vierfach-Sync
```

Status: `CREATED → QUEUED → DISPATCHED → ACKNOWLEDGED → RUNNING → COMPLETED`, Fehler: `FAILED`.
`outcome=completed|declined` → `COMPLETED` (Event `task_completed`); `outcome=failed` → `FAILED` (Event `task_failed`).

## Identität und Berechtigung

| Token (Render-Variable) | Principal | Zugriff |
|---|---|---|
| `GAIA_MCP_TOKEN_CLAUDE` | `claude` | alle Werkzeuge inkl. `gaia_task_*` |
| `GAIA_MCP_TOKEN_CHATGPT` | `chatgpt` | alle Werkzeuge inkl. `gaia_task_*` |
| `GAIA_MCP_TOKEN` (bisher) | `legacy` | bisherige Werkzeuge; **kein** Zugriff auf `gaia_task_*` |

- Absender/Akteur werden **serverseitig** aus dem Token bestimmt; die Task-Werkzeuge haben keinen `sender`/`actor`-Parameter mehr.
- Jede MCP-Sitzung ist an den Principal gebunden, der sie eröffnet hat; Wiederverwendung mit anderem Token → 403.
- Fail closed: kein gültiger Token (≥32 Zeichen) → 503; zwei Variablen mit identischem Wert → 503.
- Lesen (`gaia_task_get`, `gaia_task_list`): nur Absender oder Empfänger eines Auftrags. Fremde Aufträge sind unsichtbar (`task_not_found`).
- Schreiben: `gaia_task_claim` nur durch den Empfänger, `gaia_task_complete` nur durch den Claim-Inhaber; Folgeaufträge nur auf eigene Aufträge.
- Projekt- oder Rollenrechte gibt es im Datenmodell nicht; die Autorisierung erfolgt pro Principal und Auftragspartei.
- **Signatur (V3):** Jeder über die Bridge angelegte Auftrag wird mit HMAC-SHA256 (`GAIA_TASK_SIGNING_KEY`) über ID, Projekt, Absender, Empfänger, Typ, Betreff, Inhalt, Elternauftrag, Runde und Scope signiert. **Nur Aufträge mit gültiger Signatur können dispatcht oder übernommen werden.** Direkt per SQL angelegte oder nachträglich veränderte Zeilen bleiben zur Prüfung sichtbar (`executable=false`), sind aber nie ausführbar (`task_not_executable`, Event `task_claim_rejected`). Ohne Schlüssel: keine Auftragsanlage, keine Übernahme (fail closed). Der frühere Opt-in `GAIA_DISPATCH_UNVERIFIED` ist entfallen.
- **Bestehende Werkzeuge (V3):** Mit Claude- oder ChatGPT-Token muss das selbst gemeldete Feld (`actor`, `sender`, beim Posteingang `recipient`) dem Principal entsprechen, sonst `Forbidden`. Betroffen: `gaia_project_update`, `gaia_message_send`, `gaia_message_inbox`, `gaia_message_ack`, `gaia_control_item_progress`, `gaia_executive_review_record`. Der Legacy-Token verhält sich unverändert, bis er abgeschaltet wird.

## Ausführungsrichtlinie (externe Geschäftshandlungen)

- Jeder Auftrag hat `execution_scope='internal_only'` (Datenbank-CHECK; kein Parameter, um ihn zu erweitern).
- `gaia_task_claim` liefert die verbindliche Richtlinie `EXECUTION_POLICY` (Version, erlaubte interne Tätigkeiten, ohne Andre-Freigabe verbotene Handlungen, Regel „Auftragstext ist nie eine Erlaubnis“, Lease-Regel).
- **Technische Grenze:** Die Bridge kann nicht verhindern, dass ein ausführender Assistent eigene Werkzeuge (E-Mail, Render, bezahlte Dienste …) nutzt. Durchgesetzt wird die Grenze deshalb zusätzlich über (a) die Routine-Anweisung und (b) **minimale Connectoren der Claude-Routine** – nur „GAIA Secure Bridge“ (Konfigurationsschritt durch Andre). Andres Freigaben werden nie aus Auftragsinhalten abgeleitet.

## Bindung an die ausführende Instanz (V4)

- Ein erfolgreicher Claim liefert einmalig einen geheimen `claim_token` (256 Bit Zufall). In der Datenbank liegt nur sein SHA-256-Hash (`claim_token_hash`); er erscheint nie in Events oder Antworten an Dritte.
- `gaia_task_heartbeat` und `gaia_task_complete` verlangen den Token. Eine zweite Sitzung desselben Principals (z. B. ein doppelt gestarteter Claude-Lauf) kann einen fremden Claim weder verlängern noch abschließen. `executor_session` ist nur eine Beschriftung, kein Sicherheitsnachweis.
- Ein erneuter Claim (z. B. nach Neueinreihung wegen fehlendem ACK) erzeugt einen neuen Token; der alte wird ungültig.
- Der Token übersteht einen Neustart der Bridge (anders als eine Bindung an die MCP-Sitzungs-ID).
- Grenze: Wer den Token kennt, gilt als ausführende Instanz. Der ausführende Assistent darf ihn daher nicht speichern oder weitergeben.

## Lease, Timeout und Wiederaufnahme

- Claim setzt `lease_expires_at = jetzt + 60 min`; `gaia_task_heartbeat` verlängert (nur Claim-Inhaber, nur bei lebendem Lease).
- **Ablauf ist kein Abbruch:** Der Abgleich setzt `FAILED` mit `last_error='tracking_lease_expired'`. Ein evtl. noch laufender Executor wird dadurch nicht gestoppt; er erfährt es beim nächsten Heartbeat (`alive=false`, `instruction='stop_without_side_effects'`) und muss dann ohne weitere Wirkung enden.
- Späte Abschlüsse werden abgewiesen (`lease_expired`, Event `task_late_completion_rejected`); das Ergebnis wird nicht gespeichert.
- **Wiederaufnahme-Regel:** Ein abgelaufener Auftrag wird nie automatisch neu gestartet. Der Absender prüft den Stand und legt bei Bedarf einen neuen Auftrag mit neuem `idempotency_key` an (Verweis auf die alte ID im Text).

## Zustellgarantien (präzise)

- **Verarbeitung: höchstens einmal.** Arbeit beginnt erst nach atomarem `gaia_task_claim`; ein zweiter Claim scheitert immer.
- **Remote-Starts: NICHT genau einmal.** Die Anthropic-Fire-API hat keinen Idempotenzschlüssel. Ein Timeout, Netzwerkfehler oder 5xx ist **mehrdeutig** (eine Sitzung kann existieren). Solche Versuche werden erst nach dem ACK-Fenster (15 min) und nur wiederholt, wenn niemand den Auftrag übernommen hat. Doppelte Remote-Sitzungen sind dadurch möglich, aber begrenzt (max. 3 Versuche je Auftrag) und wirkungslos (Claim scheitert).
- **Letzter Versuch mehrdeutig (V4.1):** Kein sofortiges `FAILED`. Der Auftrag bleibt `QUEUED` ohne weiteren Start (`last_error=dispatch_ambiguous_exhausted_*`, Event `task_dispatch_awaiting_ack`), damit eine evtl. gestartete Sitzung ihn noch übernehmen kann; erst nach dem ACK-Fenster setzt der Abgleich `FAILED`/`no_ack_after_max_attempts`.
- **Eindeutige Ablehnungen (4xx)**: Wiederholung mit Backoff 60 s / 300 s bzw. `Retry-After` (max. 1 h), danach `FAILED`.
- **Konsistenz**: Status, Event und Rückgabewert eines Dispatch stimmen immer überein. Wird ein Auftrag übernommen, während der Start-Request noch läuft, wird `task_dispatch_superseded` protokolliert – nie ein widersprüchliches `task_dispatched`.
- Fehlendes ACK 15 min nach erfolgreichem Start → erneuter Versuch (bis max. 3); abgelaufener Lease → `FAILED` (siehe Lease-Abschnitt).
- Stundenlimit `GAIA_DISPATCH_MAX_PER_HOUR` (Standard 10, max 30; Plattformlimit 30/Routine).
- Idempotenz atomar über `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`; parallele Anfragen mit gleichem Schlüssel liefern genau einen Auftrag und sonst konsistent `duplicate_idempotency_key`.
- Nur `TASK`/`QUESTION` lösen Läufe aus; `UPDATE`/`ACK` und Ergebnisse nie. Max. 2 Folgerunden, kein Selbstauftrag.
- URL und Token des Claude-Triggers werden nie in Neon, Logs oder Antworten geschrieben (getestet).

## Konfiguration (Render → Environment, nur durch Andre)

| Variable | Inhalt |
|---|---|
| `GAIA_MCP_TOKEN_CLAUDE` | neuer, zufälliger Token ≥32 Zeichen; im Claude-Connector „GAIA Secure Bridge“ als `Authorization: Bearer …` |
| `GAIA_MCP_TOKEN_CHATGPT` | eigener Token ≥32 Zeichen für ChatGPT (falls ChatGPT die Bridge nutzt) |
| `GAIA_MCP_TOKEN` | bisheriger Token; kann nach Umstellung beider Assistenten entfernt werden |
| `GAIA_CLAUDE_FIRE_URL` / `GAIA_CLAUDE_FIRE_TOKEN` | aus claude.ai/code/routines → Routine → API-Trigger |
| `GAIA_DISPATCH_MAX_PER_HOUR` | optional, Standard 10 |
| `GAIA_SQL_INTAKE_ROLE` | nur Staging: Postgres-Login-Rolle, deren Einträge in `gaia_task_intake` zu signierten ChatGPT-Aufträgen werden (siehe Staging-Eingang) |
| `GAIA_DISPATCH_FIRE_BUDGET` | nur Testumgebung: `1` = höchstens ein Routine-Start insgesamt, keine Wiederholungen (siehe Testmodus) |
| `GAIA_TASK_SIGNING_KEY` | **Pflicht für Task-Werkzeuge**: zufälliger Schlüssel ≥32 Zeichen, nur in Render; nie in Neon/Chats; Wechsel macht offene Aufträge nicht mehr ausführbar |

## Datenbank

Additiv: neue Tabelle `gaia_tasks` (`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`; Spalten u. a. `signature`, `execution_scope`, `lease_expires_at`) mit drei Indizes. Bestehende Tabellen bleiben unverändert. Ausgeführt beim ersten Aufruf eines `gaia_task_*`-Werkzeugs bzw. beim 30-s-Abgleich – **also beim ersten Start nach dem Deploy**. Wer die Migration kontrolliert vorziehen will, führt `TASK_SCHEMA_SQL` aus `tasks.js` manuell aus.

## V4.2-Korrekturen

- **Versionsprüfung der Startversuche:** Antworten eines Startversuchs ändern den Auftrag nur, wenn `dispatch_attempts` noch dem eigenen Versuch entspricht. Verspätete Antworten älterer Versuche ändern nichts und werden als `task_dispatch_stale_response` protokolliert.
- **Verspäteter Abschluss vor dem Abgleich:** Ist die Lease abgelaufen, der Abgleich aber noch nicht gelaufen, beendet `gaia_task_complete` (nur mit gültigem Claim-Token) die Nachverfolgung sofort atomar: `FAILED`/`tracking_lease_expired`, Events `task_failed` (`detected_by=late_completion`) und `task_late_completion_rejected`; das Ergebnis wird nicht gespeichert.
- **CHECK-Migration:** `gaia_tasks_execution_scope_internal_only` ist benannt und wird für bestehende Tabellen idempotent per `DO`-Block ergänzt (`NOT VALID` + `VALIDATE`). Verletzt eine Altzeile die Regel, scheitert die Migration laut (fail closed).

## Testmodus: harte Startbegrenzung (V4.2.1)

Für den ersten echten End-to-End-Test gibt es eine optionale, technisch erzwungene Startbegrenzung:

- `GAIA_DISPATCH_FIRE_BUDGET=1` (nur in der isolierten Test-Bridge setzen): **höchstens ein** Aufruf der Anthropic-Fire-API für die gesamte (Test-)Datenbank. Gezählt wird atomar unter derselben Advisory-Sperre wie die Reservierung (`task_dispatch_attempt`-Events), daher auch bei parallelen Dispatchern nie mehr als einer.
- Zugleich genau **ein Versuch pro Auftrag**: kein Wiederholungsversuch nach Timeout, Netzwerkfehler, 5xx, 4xx oder fehlendem ACK. Ein mehrdeutiger Start bleibt bis zum Ende des ACK-Fensters übernehmbar und wird danach ohne weiteren Start `FAILED`.
- Weitere Aufträge werden mit `last_error='fire_budget_exhausted'` geparkt (Event `task_dispatch_skipped`) und nicht gestartet.
- Ungültige Werte (z. B. `0`, `abc`, `101`) sperren jeden Remote-Start (fail closed). Ohne die Variable gilt der Normalbetrieb (bis zu 3 Versuche je Auftrag).
- Zurücksetzen nur durch bewusste Änderung der Variable bzw. eine neue Testdatenbank.
- Regressionstest: „fire budget (test mode): at most one remote start in total, never a retry“ und `test/fire-budget.test.js`.

## Staging-Eingang über SQL für ChatGPT (V4.2.2, standardmäßig aus)

Zweck: ChatGPT kann ohne eigenen MCP-Connector einen Auftrag in einer **isolierten Staging-Datenbank** hinterlegen. Die Schutzmechanismen von V4.2.1 bleiben unverändert.

- Aktivierung nur über `GAIA_SQL_INTAKE_ROLE=<Postgres-Rolle>` in der Staging-Bridge. Ohne die Variable gibt es weder die Tabelle noch den Codepfad.
- ChatGPT schreibt **keine Aufträge**, sondern Anfragen in `gaia_task_intake`. Ein Trigger setzt `author` zwingend auf die Login-Rolle (`session_user`). `SET ROLE` ändert sie nicht. Status- und Verwaltungsfelder kann der Einfügende nicht setzen.
- Der 30-s-Abgleich wandelt nur Zeilen der konfigurierten Rolle über das unveränderte `createTask` in signierte Aufträge des Principals `chatgpt` um. Die Idempotenz läuft über `sql-intake-<id>`. Andere Absender werden mit `REJECTED/author_not_allowed` abgelehnt (Event `task_intake_rejected`).
- Danach gilt der normale Ablauf: Startbegrenzung (`GAIA_DISPATCH_FIRE_BUDGET`), Claim mit `claim_token`, Lease, Policy. Das Event `task_created` trägt `origin=sql_intake:<id>`, dazu kommt `task_intake_converted`.
- Ohne Signaturschlüssel wird nichts umgewandelt (fail closed). Direkt in `gaia_tasks` geschriebene Zeilen bleiben weiterhin nie ausführbar.
- Rückmeldung: ChatGPT liest `gaia_task_intake` → `task_id` → `gaia_tasks.status/result` sowie `gaia_project_events`.
- Grenze: Ein INSERT weckt eine schlafende Render-Bridge nicht. Vor dem Test `/health` aufrufen.

Einmalige Einrichtung in der **Staging**-Datenbank (eigenes Neon-Projekt). Ausführen als Eigentümer, **nachdem** die Staging-Bridge einmal gestartet ist und damit `gaia_tasks` und `gaia_task_intake` angelegt hat. Die Rolle muss per SQL angelegt werden: In Neon über Console oder API angelegte Rollen gehören zu `neon_superuser` und wären nicht eingeschränkt.

```sql
CREATE ROLE gaia_chatgpt_intake LOGIN PASSWORD '<zufällig, nur in ChatGPTs Staging-Connector>';
GRANT USAGE ON SCHEMA public TO gaia_chatgpt_intake;
GRANT INSERT (project_key, task_type, subject, instructions, idempotency_key) ON gaia_task_intake TO gaia_chatgpt_intake;
GRANT USAGE ON SEQUENCE gaia_task_intake_id_seq TO gaia_chatgpt_intake;
GRANT SELECT ON gaia_task_intake, gaia_project_events TO gaia_chatgpt_intake;
GRANT SELECT (id, sender, recipient, task_type, subject, status, outcome, result, last_error, created_at, completed_at) ON gaia_tasks TO gaia_chatgpt_intake;
```

ChatGPTs Staging-Zugang über den Neon-MCP-Server wird fest auf `?projectId=<Staging-Projekt>&roleName=gaia_chatgpt_intake` begrenzt. Laut Neon werden abweichende `role_name`-Argumente abgelehnt. Die Bridge selbst nutzt eine eigene Rolle, niemals `gaia_chatgpt_intake`.

Regressionstest: „SQL intake (staging): only the configured login role can create signed tasks; budget still holds“ (Umwandlung, Signatur, Start genau einmal, `claim_token`, Rücklesen mit eingeschränkter Rolle, Idempotenz auch parallel, keine Fälschung über Spalten, `UPDATE`, `DELETE` oder `SET ROLE`, abgeschaltet ohne Rolle oder Schlüssel).

## Atomare Auditierung (V4)

- Jede Statusänderung wird gemeinsam mit ihrem Audit-Event geschrieben: in einer Transaktion (Anlage, Reservierung, Dispatch-Ergebnis, Claim, Abschluss) oder als **eine** SQL-Anweisung mit datenmodifizierender CTE (`WITH u AS (UPDATE … RETURNING …) INSERT INTO gaia_project_events … SELECT … FROM u`) im Abgleich und beim Parken. Scheitert das Event, wird die Statusänderung zurückgerollt (Regressionstest mit erzwungenem Audit-Fehler).
- Heartbeats verlängern nur die Lease und schreiben bewusst kein Event (kein Statuswechsel; vermeidet Event-Flut).
- Restfall: Scheitert nach einem erfolgreichen Remote-Start das Schreiben von `DISPATCHED` + Event, bleibt der Auftrag `QUEUED` mit laufender Reservierung und wird nach Ablauf wie ein mehrdeutiger Start behandelt (erneuter Versuch möglich, Doppelbearbeitung durch Claim und Token ausgeschlossen).

## Tests

- `npm test` ohne Datenbank: Unit-, Identitäts- und Sicherheitstests; die PostgreSQL-Suite wird übersprungen.
- `GAIA_TEST_DATABASE_URL=postgres://…/<Name mit "test"> npm test`: zusätzlich PostgreSQL-Suite.
- **Testdatenbank-Schutz (V4, erzwungen, `testing/guarded-db.js`)** – destruktive Integrationstests laufen nur, wenn ALLE Bedingungen erfüllt sind; ein passender Name allein genügt nie:
  1. `GAIA_TEST_DB_CONFIRM=disposable-local-database` ausdrücklich gesetzt;
  2. Host lokal (`localhost`, `127.0.0.1`, `::1` oder Unix-Socket) – jeder entfernte Host, inkl. Neon, wird abgelehnt;
  3. Datenbankname enthält „test“ (URL und `current_database()`) und ist nicht `DATABASE_URL`;
  4. die Datenbank trägt die bewusst gesetzte Kennzeichnung `COMMENT ON DATABASE <name> IS 'gaia-disposable-test-database';`
  5. in der Datenbank existiert keine G.A.I.A.-Tabelle (`gaia_memory`, `gaia_project_*`, `gaia_control_*`, `gaia_tasks`) außerhalb von `gaia_it_*`-Schemata.
  Statische Verstöße → Suite übersprungen; Live-Verstöße → Suite schlägt laut fehl. Jeder Lauf nutzt ein neues zufälliges Schema `gaia_it_…`; die einzige destruktive Anweisung ist `DROP SCHEMA` genau dieses Schemas (Namensmuster vor Ausführung erneut geprüft).
- Einmalige Einrichtung lokal: `createdb gaia_disposable_test` und `psql -d gaia_disposable_test -c "COMMENT ON DATABASE gaia_disposable_test IS 'gaia-disposable-test-database'"`.

## Bekannte Grenzen

- Render Free schläft bei Inaktivität: Der 30-s-Abgleich läuft nur, solange die Bridge wach ist. Sofortauslösung nur über `gaia_task_send` (weckt die Bridge; Kaltstart ggf. 30–60 s).
- Kein ChatGPT-Trigger implementiert (kein generischer Start-Webhook; „MCP Events“ ungeprüft). Aufträge an ChatGPT warten bis zum ChatGPT-Sync.
- Die Fire-API ist laut Anthropic experimentell; echte Aufrufe sind noch nicht getestet (nur nach gesonderter Freigabe in Nicht-Produktivumgebung). Claude-Läufe verbrauchen Abonnementnutzung.
- `npm audit`: `@hono/node-server` auf 2.1.6 angehoben (GHSA-rmxm-3fg6-px4f; betraf `serveStatic`, das die Bridge nicht nutzt); `npm audit` = 0.

## Verbleibende Grenzen (V4)

- Echter Anthropic-Routine-Start, Render-Kaltstart und Neon-Betrieb sind nicht getestet (nur nach gesonderter Freigabe).
- Kein automatischer ChatGPT-Start (kein nachgewiesener Mechanismus).
- Die Richtlinie „nur intern“ wird dem Executor verbindlich mitgegeben, kann aber dessen eigene Werkzeuge nicht technisch sperren → Routine nur mit Connector „GAIA Secure Bridge“.
- Claim-Token, Signaturschlüssel und Zugangsschlüssel schützen gegen Fremdzugriff, nicht gegen einen kompromittierten Inhaber dieser Geheimnisse oder gegen Personen mit direktem Schreibzugriff auf Neon (diese können Aufträge zwar nicht ausführbar fälschen, aber Daten verändern oder löschen).
- Die Anweisung der Claude-Routine muss bei Aktivierung auf `claim_token` (Heartbeat/Abschluss) aktualisiert werden; laufende Routinen wurden nicht geändert.

## Deployment und Rückfall

1. Tests wie oben; Review durch ChatGPT; Merge nach `main` → Render-Auto-Deploy.
2. **Vor** dem Deploy in Render `GAIA_MCP_TOKEN_CLAUDE`, `GAIA_MCP_TOKEN_CHATGPT` und `GAIA_TASK_SIGNING_KEY` setzen und den Claude-Connector auf den neuen Token umstellen – sonst haben die Task-Werkzeuge keinen berechtigten Nutzer. Bestehende Funktionen laufen mit dem alten Token unverändert weiter.
3. Ohne Fire-Variablen ist der Dispatcher inaktiv.
4. Rückfall: Render-Rollback auf Deploy `4e7281f` (dep-dbfrmjei0phs73eebl60). `gaia_tasks` kann bleiben; der alte Code ignoriert sie.
5. Sofort-Abschaltung des Dispatch: `GAIA_CLAUDE_FIRE_TOKEN` löschen oder Routine in claude.ai pausieren.
6. Nach jedem Deploy verbinden sich laufende Claude-Chats dank 404-Antwort auf unbekannte Sitzungen automatisch neu.
