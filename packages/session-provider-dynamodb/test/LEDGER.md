# Test ledger: @spinajs/session-provider-dynamodb

Every `it` of the 2.x suite of this package at `3d22b6c8f`, classified per
plan §1 rule 6 (F5). Classes: move, adapt, rewrite, drop (definitions:
`.authz-sdd/F5-task-7-brief.md` → kept in the header below).
Rewrite-class files go to `test/legacy-v2/` in their C/N lane; the T lane
replaces them and deletes the legacy file.

- **move**: the test's code and assertions stay as they are; only the file moves to another package because the code under test moves there. Imports and fixtures may change, the assertions do not.
- **adapt**: the test stays (in this package, or in the package the code moves to) with mechanical edits that keep its intent and its expected values.
- **rewrite**: the test asserts 2.x authorization API or behaviour that 3.0 replaces, or 2.x authentication behaviour that an N lane redesigns. The owning C/N lane moves the file to `test/legacy-v2/`; a T lane (or the N lane) writes the 3.0 replacement, named by the rule ids in the Target column.
- **drop**: no 3.0 counterpart; the reason is in the Target column.

| Class | Count |
|---|---|
| move | 0 |
| adapt | 7 |
| rewrite | 1 |
| drop | 0 |
| **total** | 8 |

Lane codes: N2 authn-session and session providers.

Contract change (G1, `authn-session/src/contracts.ts`): every `UserSession` is built with `Subject: { type: 'user', id }` and `State: 'active'` instead of `UserId`; `deleteByUser`/`listByUser` become `deleteBySubject`/`listBySubject`. Hashing of session ids (A07, SR-18) lives in `SessionIssuer`; a store keys rows by the SessionId it gets, so raw keys in these tests stay.

Conformance suite: the tests also import `runSessionProviderConformance` from `../../users/test/conformance/session-provider-conformance.ts`. The users ledger classes that file "move" to `authn-session/test/conformance/` (N2); the import path changes with it. Its `it` rows are ledgered in `packages/users/test/LEDGER.md`, not here.

## test/session-provider.test.ts

DynamoDB regressions on `DynamoDbSessionProvider` over an in-memory fake client. Dominant class: adapt (N2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 144 | dynamodb session provider > DynamoDbSessionProvider regressions > deleteByUser removes only the target user's sessions, keyed on numeric UserId (B4) | adapt | N2 | session-provider-dynamodb/test/ Expected null / not-null unchanged. The fake's `ScanCommand` filter (lines 104-108, `:uid` with `.N`) must match the new subject attribute; `deleteByUser(1)` becomes `deleteBySubject(ref)`; the title's "numeric UserId (B4)" no longer describes the check. The impersonator set (N2 task 6, SR-06) is a new N2 test, not part of this adapt. |
| 2 | 170 | dynamodb session provider > DynamoDbSessionProvider regressions > persists UserId as a top-level numeric DynamoDB attribute | rewrite | N2 → N2 | session-provider-dynamodb/test/v3/ — the subject persists as top-level attribute(s) that the `deleteBySubject` scan filters on, and restores as the same `IdentityRef`; G1 contract `ISession.Subject: IdentityRef` (design §22.3), A08. The 2.x test expects `restored!.UserId` to equal `77`; there is no numeric `UserId` in 3.0. |

## test/session.test.ts

Live-DynamoDB integration run (skipped unless `DYNAMO_INTEGRATION=1`; needs localhost:8000). Dominant class: adapt (N2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 83 | should insert session | adapt | N2 | session-provider-dynamodb/test/ Import path plus `Subject`/`State` on the session; stays skipped by default. |
| 2 | 104 | should update session | adapt | N2 | session-provider-dynamodb/test/ Import path plus `Subject`/`State` on the session. |
| 3 | 127 | should delete session | adapt | N2 | session-provider-dynamodb/test/ Import path plus `Subject`/`State` on the session. |
| 4 | 149 | should touch session | adapt | N2 | session-provider-dynamodb/test/ Import path plus `Subject`/`State`. Its three `expect(...)` calls (lines 172-174) assert nothing (no matcher). `touch` renews through the expiration strategy and overwrites the assigned `date2`, so do not assert `sR2 === date2`; if N2 tightens it, assert `touch()` returns `true` and `sR2.Expiration > sR.Expiration`. |
| 5 | 176 | should return null when session expired | adapt | N2 | session-provider-dynamodb/test/ Import path plus `Subject`/`State` on the session. Real 5 s wait; the fake-backed run covers expiry. |
| 6 | 211 | should return null if session not exist | adapt | N2 | session-provider-dynamodb/test/ Import path plus `Subject`/`State` on the session. |
