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
| move | 1 |
| adapt | 10 |
| rewrite | 0 |
| drop | 0 |
| **total** | 11 |

Lane codes: N2 authn-session and session providers.

Conformance suite: the tests also import `runSessionProviderConformance` from `../../users/test/conformance/session-provider-conformance.ts`. The users ledger classes that file "move" to `authn-session/test/conformance/` (N2); the import path changes with it. Its `it` rows are ledgered in `packages/users/test/LEDGER.md`, not here.

## test/session-provider.test.ts

Session store regressions and the `Data` column codec on the sqlite-backed `DbSessionStore`. Dominant class: adapt (N2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 115 | db session provider > DbSessionStore regressions > reads the correctly-spelled authn.session.db.cleanupInterval config key (B2) | adapt | N2 | session-provider-db/test/ The key is already `authn.session.db.*`; assertion unchanged. |
| 2 | 124 | db session provider > DbSessionStore regressions > save preserves an already-set Expiration exactly, under sliding mode (B3) | adapt | N2 | session-provider-db/test/ Import `UserSession` from `@spinajs/authn-session`. Hashed storage (A07) is invisible: `restore('b3-verbatim')` still takes the raw id. |
| 3 | 143 | db session provider > DbSessionStore regressions > assigns an initial expiration only when a brand-new session has none | adapt | N2 | session-provider-db/test/ Import path only; strategy and expected 60 minute window unchanged. |
| 4 | 167 | db session provider > DbSessionStore regressions > cleanupExpired removes expired sessions and keeps live ones | adapt | N2 | session-provider-db/test/ The direct `DbSession.where({ SessionId: ... })` lookups must use the stored hash of the id (A07, SR-18); counts and outcome unchanged. |
| 5 | 196 | db session provider > DbSessionStore regressions > cleanupExpired is a no-op when nothing expired | adapt | N2 | session-provider-db/test/ Import path only. |
| 6 | 268 | db session provider > session Data: json column (object) and text column (string) > decodes an already-parsed object and the equivalent string to the identical session | adapt | N2 | session-provider-db/test/ Imports `encodeSessionData` from `@spinajs/authn-session` (N2 task 1 moves the codec); the `toSession` row fixture gains the hashed `SessionId` shape. |
| 7 | 289 | db session provider > session Data: json column (object) and text column (string) > rebuilds the tagged payload from an object without going through JSON text | move | N2 | authn-session/test/ Pure `decodeSessionData` check with no store; the codec moves to `authn-session` (N2 task 1). Assertions unchanged; N2 may keep it here as an adapt if it prefers one file. |
| 8 | 298 | db session provider > session Data: json column (object) and text column (string) > reads a Buffer-delivered payload (blob-ish column / binary driver mode) | adapt | N2 | session-provider-db/test/ Import path only; a Buffer payload still decodes through `toSession`. |
| 9 | 318 | db session provider > session Data: json column (object) and text column (string) > runs both converging migrations on startup without failing on a driver that cannot MODIFY | adapt | N2 | session-provider-db/test/ Keep both assertions; add `UserSessionIdHash_2026_10_02_00_00_00` to the recorded-names list (N2 task 6) and check it records on sqlite too. |
| 10 | 335 | db session provider > session Data: json column (object) and text column (string) > both migrations resolve to SKIP on this sqlite connection | adapt | N2 | session-provider-db/test/ Assertions unchanged. Add the same non-MySQL probe for `UserSessionIdHash` (`SessionId` to 64, `ImpersonatorId` + index) so it cannot run `MODIFY` on sqlite. |
| 11 | 354 | db session provider > session Data: json column (object) and text column (string) > round-trips a saved session back out of the store with its structural types intact | adapt | N2 | session-provider-db/test/ Import path only; hashed storage stays invisible (A07). |
