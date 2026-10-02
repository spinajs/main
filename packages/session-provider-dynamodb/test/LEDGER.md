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
| adapt | 8 |
| rewrite | 0 |
| drop | 0 |
| **total** | 8 |

Lane codes: N2 authn-session and session providers.

Conformance suite: the tests also import `runSessionProviderConformance` from `../../users/test/conformance/session-provider-conformance.ts`. The users ledger classes that file "move" to `authn-session/test/conformance/` (N2); the import path changes with it. Its `it` rows are ledgered in `packages/users/test/LEDGER.md`, not here.

## test/session-provider.test.ts

DynamoDB regressions on `DynamoDbSessionProvider` over an in-memory fake client. Dominant class: adapt (N2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 144 | dynamodb session provider > DynamoDbSessionProvider regressions > deleteByUser removes only the target user's sessions, keyed on numeric UserId (B4) | adapt | N2 | session-provider-dynamodb/test/ Import path only. The fake's `ScanCommand` `:uid` filter must still serve `deleteByUser`; add the impersonator set (N2 task 6, SR-06). Keep the numeric `UserId` unless the contract changes the subject type. |
| 2 | 170 | dynamodb session provider > DynamoDbSessionProvider regressions > persists UserId as a top-level numeric DynamoDB attribute | adapt | N2 | session-provider-dynamodb/test/ The assertion goes through `restore`, so it holds while `UserId` stays numeric. If `authn-session` types the subject as a string or `IdentityRef`, N2 changes the expected value and names the rule. |

## test/session.test.ts

Live-DynamoDB integration run (skipped unless `DYNAMO_INTEGRATION=1`; needs localhost:8000). Dominant class: adapt (N2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 83 | should insert session | adapt | N2 | session-provider-dynamodb/test/ Import path only; stays skipped by default. |
| 2 | 104 | should update session | adapt | N2 | session-provider-dynamodb/test/ Import path only. |
| 3 | 127 | should delete session | adapt | N2 | session-provider-dynamodb/test/ Import path only. |
| 4 | 149 | should touch session | adapt | N2 | session-provider-dynamodb/test/ Import path only. Its `expect(...)` calls assert nothing (no matcher); N2 should add real `.to.equal` checks while porting. |
| 5 | 176 | should return null when session expired | adapt | N2 | session-provider-dynamodb/test/ Import path only. Real 5 s wait; the fake-backed run covers expiry. |
| 6 | 211 | should return null if session not exist | adapt | N2 | session-provider-dynamodb/test/ Import path only. |
