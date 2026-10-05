# Test ledger: @spinajs/queue-http-progress

Every `it` of the 2.x suite of this package at `3d22b6c8f`, classified per
plan §1 rule 6 (F5). Classes: move, adapt, rewrite, drop (definitions:
`.authz-sdd/F5-task-7-brief.md`, kept in the header below).
Rewrite-class files went to `test/legacy-v2/` in their C/N lane; the T lane
replaces them and deletes the legacy file.

- **move**: the test's code and assertions stay as they are; only the file moves to another package because the code under test moves there.
- **adapt**: the test stays (in this package, or in the package the code moves to) with mechanical edits that keep its intent and its expected values.
- **rewrite**: the test asserts 2.x authorization API or behaviour that 3.0 replaces, or 2.x authentication behaviour that an N lane redesigns; the owning lane moves the file to `test/legacy-v2/` and a T (or N) lane writes the 3.0 replacement, named in the Target column with the rule ids.
- **drop**: no 3.0 counterpart; the reason is in the Target column.

| Class | Count |
|---|---|
| move | 0 |
| adapt | 2 |
| rewrite | 0 |
| drop | 0 |
| **total** | 2 |

## test/JobsController.test.ts

2 tests; dominant class adapt (adapt 2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 36 | JobsController > getStatus() > should return Ok with job status when job exists | adapt | C8, T4: closed | queue-http-progress/test/ (`getStatus` unit tests stay and still call the method directly, since `@Access('job:read', { resource: fromParam('jobId', 'job') })` sits on the route; T4 adds own job 200, other user job 403/404, admin with `job:read` 200, B30) |
| 2 | 53 | JobsController > getStatus() > should return a queued status when no tracking row exists | adapt | C8, T4: closed | queue-http-progress/test/ (`getStatus` unit tests stay and still call the method directly, since `@Access('job:read', { resource: fromParam('jobId', 'job') })` sits on the route; T4 adds own job 200, other user job 403/404, admin with `job:read` 200, B30). Note for T4: at route level, with `fromParam` and the `job` adapter (B30), an unknown job id may answer 403/404 instead of `queued`; the route test must fix which |

## C8 outcome

- T4: closed. The route-level own 200, other-user 404 (design B30: denied and unknown answer alike), admin 200 and 401 cases are in `test/status-route.test.ts`; no `test/legacy-v2/` existed.
- Test 1 adapted: `getStatus(jobId, req)` with a stubbed `canRead`.
- Test 2 adapted: an unknown job now answers 404 (`ResourceNotFound`), the same as a denied job; the `queued` fallback is gone.
- New: `test/behaviour.test.ts` runs B30.status; `test/status-route.test.ts` pins own 200, other user's job 404, unknown JobId 404 with the same body, unconditional holder 200, no principal 401.
