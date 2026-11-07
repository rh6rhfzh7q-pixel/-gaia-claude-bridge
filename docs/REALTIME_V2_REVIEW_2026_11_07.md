# G.A.I.A. Realtime Tasks V2 – Independent Review

Date: 2026-11-07
Source: V2 patch pasted into conversation and Claude's pasted test protocol; original patch bytes not available as an uploaded .patch.
Decision: NO MERGE / NO DEPLOY pending remediation and reproducible verification.

## Positive changes verified by static inspection
- Principal determined from separate bearer tokens; legacy principal barred from task tools.
- MCP transport session bound to principal for POST/GET/DELETE.
- Task send/claim/complete do not expose sender or actor inputs.
- Atomic claim restricted to recipient, with audit of superseded dispatches.
- Tests use isolated schema and explicit test database guard.
- Failure outcome maps to FAILED and task_failed.

## Findings

### P1 – Unverified SQL tasks can still be claimed and executed
`sweep` promotes direct-SQL tasks to QUEUED and leaves them visible to the recipient. `claimTask` accepts QUEUED regardless of `sender_verified` and `created_via`. The `GAIA_DISPATCH_UNVERIFIED` flag only gates automatic outbound fire, not task execution by a scheduled Claude sync. A forged SQL task can therefore be executed by a polling recipient. Enforce sender verification or explicit approval at claim time, not merely at dispatch time; separate 'visible for review' from 'authorized for execution'.

### P1 – Untrusted task content can request external actions
The description says 'internal work only' but no code-level policy checks enforce this. A valid assistant principal can send arbitrary instructions. Keep an explicit user approval gate for external actions and define executor policy rather than relying on tool description.

### P2 – Claimed task may time out and still be processed
`sweep` marks RUNNING tasks FAILED after 60 minutes. `completeTask` then rejects completion, but no cancellation mechanism stops the original executor. This is a lease/timeout semantic issue: document that timeout is not cancellation and prevent downstream actions after expiry unless reauthorized.

### P2 – Authentication migration leaves legacy tools vulnerable
As acknowledged in V2 docs, existing non-task tools still accept self-reported actor fields. Per-assistant credentials alone do not secure those operations. Treat this as a separate explicit hardening gate before claiming end-to-end identity security.

### P2 – Tests do not prove real provider compatibility
The Anthropic fire endpoint and response shape are mocked; no staging fire request, real authentication, cold-start, reconnect or Render/Neon end-to-end test is shown.

### P2 – npm audit warning remains
Claude reports moderate vulnerability in transitive @hono/node-server; assess applicability and pin a patched dependency version after compatibility tests.

### P2 – Reproducibility / source integrity
The SHA256 manifest is present, but the raw .patch and .txt files were not uploaded. The pasted text is insufficient to verify exact bytes, CRLF-sensitive patch application or hashes. Claude's commit 99b9949 is not accessible in the GitHub repository as checked on 2026-11-07. Do not claim independent test reproduction.

### P3 – Idempotency race
`createTask` does SELECT then INSERT with a unique key; concurrent same-key requests can throw a unique violation rather than return a consistent duplicate response. Consider INSERT ... ON CONFLICT or retry lookup.

## Next actions
1. Ask Claude to address P1 unverified task claim, and document explicit external-action approval.
2. Upload original .patch and test-protocol .txt for hash verification and application to feature/realtime-tasks-review.
3. Run safe unit and isolated PostgreSQL tests; review actual diff and open draft PR only after code is present.
4. Explicit user authorization required for merge, deployment, token changes and Neon migration.

No production changes authorized.
