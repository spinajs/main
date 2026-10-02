# Test ledger: @spinajs/session-provider-redis

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
| adapt | 4 |
| rewrite | 0 |
| drop | 0 |
| **total** | 4 |

Lane codes: N2 authn-session and session providers.

Contract change (G1, `authn-session/src/contracts.ts`): every `UserSession` is built with `Subject: { type: 'user', id }` and `State: 'active'` instead of `UserId`; `deleteByUser`/`listByUser` become `deleteBySubject`/`listBySubject`. Hashing of session ids (A07, SR-18) lives in `SessionIssuer`; a store keys rows by the SessionId it gets, so raw keys in these tests stay.

Conformance suite: the tests also import `runSessionProviderConformance` from `../../users/test/conformance/session-provider-conformance.ts`. The users ledger classes that file "move" to `authn-session/test/conformance/` (N2); the import path changes with it. Its `it` rows are ledgered in `packages/users/test/LEDGER.md`, not here.

## test/session-provider.test.ts

Redis-specific regressions on `RedisSessionStore` over `ioredis-mock`. Dominant class: adapt (N2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 88 | redis session provider > RedisSessionStore regressions > deleteByUser removes only the target user's sessions across multiple users | adapt | N2 | session-provider-redis/test/ Import path, `Subject`/`State` on the sessions; `deleteByUser(1)` becomes `deleteBySubject(ref)`, which now returns a count. The outcome must hold with the new impersonator set (N2 task 6, SR-06). |
| 2 | 107 | redis session provider > RedisSessionStore regressions > listByUser returns live sessions and prunes expired ids from the user set | adapt | N2 | session-provider-redis/test/ `listByUser(9)` becomes `listBySubject(ref)`; the raw key `session:r-expired` stays (the store keys by the id it gets); the subject index key `session:user:9` follows N2's new per-subject key format (an `IdentityRef`). Expected members `['r-live']` and result unchanged. |
| 3 | 133 | redis session provider > RedisSessionStore regressions > save persists an already-set Expiration verbatim | adapt | N2 | session-provider-redis/test/ Import path plus `Subject`/`State` on the session. |
| 4 | 147 | redis session provider > RedisSessionStore regressions > restore returns null for an expired session even if the mock kept the key | adapt | N2 | session-provider-redis/test/ The raw key `session:r-ghost` stays; only `Subject`/`State` fields change. The `isExpired` gate expectation is unchanged. |
