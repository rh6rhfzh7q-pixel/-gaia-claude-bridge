# G.A.I.A. Realtime Tasks – Preliminary Security Review

Date: 2026-11-07
Base: 4e7281fdc4255d491dac80b73a9c3fbe2919de6c
Scope: User-supplied unified diff and accompanying technical handover. This is a preliminary static review, not a verified build or production test.

## Blocking issues

1. **Actor impersonation (critical).** `gaia_task_send` accepts caller-supplied `sender`, and `gaia_task_claim` / `gaia_task_complete` accept caller-supplied `actor`. The generic bridge bearer token does not, in the supplied diff, bind these values to an authenticated identity. A caller with bridge access can potentially impersonate another assistant. Require actor-specific authenticated credentials and server-side binding before deployment. Do not trust self-reported actor names.

2. **Dispatch/claim race (high).** `claimTask` allows claiming `QUEUED` while `dispatchTask` is making an outbound API call. After a successful response, `dispatchTask` performs a conditional update to `DISPATCHED` but logs `task_dispatched` and returns success without checking whether the update affected a row. Ensure event, status and returned result cannot contradict each other.

3. **Duplicate routine starts (high).** A timed-out or ambiguous fire request may have created a remote session. Retries can create additional Claude sessions. The claim reduces duplicate task execution, but does not establish exactly-once remote starts. Describe the guarantee accurately and test ambiguous API responses.

4. **Unsafe database test fixture (high).** `test/tasks.pg.test.js` issues `DROP TABLE IF EXISTS gaia_tasks; DROP TABLE IF EXISTS gaia_project_events;` against whichever database `GAIA_TEST_DATABASE_URL` targets. Add an enforceable test-only database guard and use isolated schemas/databases before anyone runs these tests.

5. **Authorization and data exposure (high).** `gaia_task_get` and `gaia_task_list` expose task instructions and results without demonstrated per-actor access controls. Add read and write authorization by authenticated principal, task recipient, project and role.

## Further review

- Verify `gaia_tasks` schema migration permissions and no production mutation before approval.
- Ensure `task_completed` event type and terminal state agree when `outcome='failed'`.
- Verify retry handling and late acknowledgements under concurrent execution.
- Confirm actual Anthropic fire API and trigger behavior in a non-production environment.
- Confirm patch integrity and reproduce all tests from the original raw .patch, not PDF text.

## Decision

**NO MERGE / NO DEPLOY.** This review records blockers only. It does not modify the application, Neon, Render or any business execution gate.
