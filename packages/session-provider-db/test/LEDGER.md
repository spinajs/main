# Test ledger: @spinajs/session-provider-db

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
| adapt | 11 |
| rewrite | 0 |
| drop | 0 |
| **total** | 11 |

Lane codes: N2 authn-session and session providers.

Contract change (G1, `authn-session/src/contracts.ts`): every `UserSession` is built with `Subject: { type: 'user', id }` and `State: 'active'` instead of `UserId`; `deleteByUser`/`listByUser` become `deleteBySubject`/`listBySubject`. Hashing of session ids (A07, SR-18) lives in `SessionIssuer`; a store keys rows by the SessionId it gets, so raw keys in these tests stay.

Conformance suite: the tests also import `runSessionProviderConformance` from `../../users/test/conformance/session-provider-conformance.ts`. The users ledger classes that file "move" to `authn-session/test/conformance/` (N2); the import path changes with it. Its `it` rows are ledgered in `packages/users/test/LEDGER.md`, not here.

## test/session-provider.test.ts

Session store regressions and the `Data` column codec on the sqlite-backed `DbSessionStore`. Dominant class: adapt (N2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 115 | db session provider > DbSessionStore regressions > reads the correctly-spelled authn.session.db.cleanupInterval config key (B2) | adapt | N2 | session-provider-db/test/ The key is already `authn.session.db.*`; assertion unchanged. |
| 2 | 124 | db session provider > DbSessionStore regressions > save preserves an already-set Expiration exactly, under sliding mode (B3) | adapt | N2 | session-provider-db/test/ Import `UserSession` from `@spinajs/authn-session`. Build the session with `Subject` and `State: 'active'`. Restore takes the stored key (`restore('b3-verbatim')` unchanged); hashing lives in `SessionIssuer`. |
| 3 | 143 | db session provider > DbSessionStore regressions > assigns an initial expiration only when a brand-new session has none | adapt | N2 | session-provider-db/test/ Import path plus `Subject`/`State` on the session; strategy and expected 60 minute window unchanged. |
| 4 | 167 | db session provider > DbSessionStore regressions > cleanupExpired removes expired sessions and keeps live ones | adapt | N2 | session-provider-db/test/ Lookups unchanged: the store keys rows by the id it gets, so `DbSession.where({ SessionId: 'expired-one' })` and `'live-one'` stay. Sessions built with `Subject` and `State: 'active'`; counts and outcome unchanged. |
| 5 | 196 | db session provider > DbSessionStore regressions > cleanupExpired is a no-op when nothing expired | adapt | N2 | session-provider-db/test/ Import path plus `Subject`/`State` on the session. |
| 6 | 268 | db session provider > session Data: json column (object) and text column (string) > decodes an already-parsed object and the equivalent string to the identical session | adapt | N2 | session-provider-db/test/ Imports `encodeSessionData` from `@spinajs/authn-session` (N2 task 1 moves the codec); the `toSession` row fixture changes for the 3.0 row columns (subject, `State`); line 286 compares `Subject` of both decodes instead of `UserId` (a relative check). |
| 7 | 289 | db session provider > session Data: json column (object) and text column (string) > rebuilds the tagged payload from an object without going through JSON text | adapt | N2 | session-provider-db/test/ Import `decodeSessionData` from `@spinajs/authn-session` (N2 task 1); assertions unchanged. Stays beside 268, 298 and 354, which share `payload()` / `assertPayload()`; it guards the MySQL `json` column handing the decoder an object. Codec round trips are also covered in `authn-session/test/session-codec.test.ts`. |
| 8 | 298 | db session provider > session Data: json column (object) and text column (string) > reads a Buffer-delivered payload (blob-ish column / binary driver mode) | adapt | N2 | session-provider-db/test/ Import path plus `Subject`/`State` on the row fixture; a Buffer payload still decodes through `toSession`. |
| 9 | 318 | db session provider > session Data: json column (object) and text column (string) > runs both converging migrations on startup without failing on a driver that cannot MODIFY | adapt | N2 | session-provider-db/test/ Keep the three `include` checks (lines 325-327); add `UserSessionIdHash_2026_10_02_00_00_00` to the recorded-names list (new N2 task 6 check). |
| 10 | 335 | db session provider > session Data: json column (object) and text column (string) > both migrations resolve to SKIP on this sqlite connection | adapt | N2 | session-provider-db/test/ Assertions unchanged. New check for `UserSessionIdHash`: the `SessionId` widen (MySQL `MODIFY`) may skip on sqlite, but `ImpersonatorId` and its index must still be added, or `deleteBySubject(..., { includeImpersonations })` breaks there. |
| 11 | 354 | db session provider > session Data: json column (object) and text column (string) > round-trips a saved session back out of the store with its structural types intact | adapt | N2 | session-provider-db/test/ Import path plus `Subject`/`State`; restore takes the stored key, hashing lives in `SessionIssuer`. |

## N2 status (done)

All 11 adapt rows are carried in `test/session-provider.test.ts` (N2
commits `1e98c8a5e`, `e9bc01cc3`): rows 1–5 keep their titles; rows 6–8
and 11 keep their titles with Subject/State rows; rows 9–10 keep their
titles and `test/session-id-hash-migration.test.ts` adds the
`UserSessionIdHash_2026_10_02_00_00_00` checks (columns, indexes,
backfill, sqlite rebuild). The shared suite now comes from
`../../authn-session/test/conformance/` with the 2.x `seedLegacy` hook;
`test/kit-conformance.test.ts` runs the kit's A07/A08/A09 store facets.
