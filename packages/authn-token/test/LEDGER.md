# Test ledger: @spinajs/authn-token

Summary (N6, C5): 61 of 61 rows done, 36 by N6 (replaced, kept or deleted) 8 by C5 (moved to `authz-rbac/test/token/`) and 17 by T3; the T3 rows are closed (`test/legacy-v2/` deleted).

Every `it` of the 2.x suite of this package at `3d22b6c8f`, classified per
plan §1 rule 6 (F5). Classes: move, adapt, rewrite, drop (definitions:
`.authz-sdd/F5-task-7-brief.md`, kept in the header below).
Rewrite-class files go to `test/legacy-v2/` in their C/N lane; the T lane
replaces them and deletes the legacy file.

- **move**: the test's code and assertions stay as they are; only the file moves to another package because the code under test moves there.
- **adapt**: the test stays (in this package, or in the package the code moves to) with mechanical edits that keep its intent and its expected values.
- **rewrite**: the test asserts 2.x authorization API or behaviour that 3.0 replaces, or 2.x authentication behaviour that an N lane redesigns; the owning lane moves the file to `test/legacy-v2/` and a T (or N) lane writes the 3.0 replacement, named in the Target column with the rule ids.
- **drop**: no 3.0 counterpart; the reason is in the Target column.

Target folders for the token role-policy rows: adapt and move rows go to `authz-rbac/test/token/` (code that stays as it is), rewrite rows to `authz-rbac/test/ported/token/` (T3 replacements); the split follows the class, not the subject. Other adapt rows target `authn-token/test/`, rewrites 72, 115 and 52 target `authn-token/test/v3/`.

Mixed files: `actions-crud` (adapt 2, 4, 5 stay with `TokenService` in authn-token; the rest go to `legacy-v2/`), `actions-validate` (adapt rows 2-4, 6-8, 11, 12 stay in authn-token; the rewrite rows go to `legacy-v2/`), `cli` (adapt rows stay; the rewrite row goes to `legacy-v2/`).

| Class | Count |
|---|---|
| move | 4 |
| adapt | 30 |
| rewrite | 20 |
| drop | 7 |
| **total** | 61 |

## test/actions-crud.test.ts

12 tests; dominant class rewrite (adapt 3, rewrite 5, drop 4).

| # | Line | Test | Class | Lane | Target | Status (N6) |
|---|---|---|---|---|---|---|
| 1 | 72 | access token actions - crud > creates token for user, returns plaintext once, stores only hash | rewrite | N6 | authn-token/test/v3/ (TokenService.create; A14; SR-08 "token without expiry refused"): expiry is mandatory, so the null `ExpiresAt` assertion changes; the plaintext-once and hash-only assertions keep | done: replaced in `v3/token-service.test.ts` and by kit case A14 "the plaintext is shown once" |
| 2 | 88 | access token actions - crud > accepts expiration date | adapt | N6 | authn-token/test/ (TokenService; owner fixture through the `users` factory) | done: `v3/token-service.test.ts` |
| 3 | 97 | access token actions - crud > rejects roles the owner does not hold | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24, B07): the roles-subset rule leaves authn-token (it imports no authz); owner roles come from RBAC assignments, not `User.Role`. DECIDED (N6): the create-time refusal survives in 3.0 through `RoleSource` when one is registered (`TokenService.create` answers `invalid_scope`, nothing persisted); without one the roles are stored as given. Check time stays authoritative: the authz-rbac ceiling keeps only roles the owner holds (L1/C5, B07) | T3: authz-rbac/test/ported/token/role-policy.test.ts "a token role the owner lacks grants nothing, not even next to roles the owner holds (crud 3, controller 4)"; create time: authn-token/test/v3/token-service.test.ts "refuses a role the owner does not hold and stores nothing". Changed: the role drops at check time instead of `AccessTokenRoleNotAllowed` at create (B07, B24, item 16 / r6 D3 / 18.3(g)) |
| 4 | 111 | access token actions - crud > resolves owner by uuid string | adapt | N6 | authn-token/test/ (TokenService; owner fixture through the `users` factory) | done: `v3/token-service.test.ts` |
| 5 | 118 | access token actions - crud > deletes token by uuid | adapt | N6 | authn-token/test/ (TokenService; owner fixture through the `users` factory) | done: `v3/token-service.test.ts` |
| 6 | 127 | access token actions - crud > grants and revokes role on token, only owner-held roles grantable | drop | N6 | 3.0 has no token role editing (design §22.9, N6, N8b); the owner-held-roles rule is covered by line 97 | done: deleted |
| 7 | 147 | access token actions - crud > refuses to revoke the last role, leaving the row untouched | drop | N6 | 3.0 has no token role editing (design §22.9, N6, N8b); no role editing, so no last-role refusal; the empty-role guard at creation is covered by line 97 | done: deleted |
| 8 | 184 | access token actions - crud > profiles > createToken stores the profile when the policy allows it | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): profile pin and `authz.token.rolePolicy` replace the `rbac.token.rolePolicy` seam; `Profile` becomes `attributes.profile` | T3: authz-rbac/test/ported/token/role-policy.test.ts "the policy offers the profile and a token pinned to it gets the answer for that profile (crud 8, controller-roles 10)"; pin stored: authn-token/test/v3/token-service.test.ts "pins a profile only when the policy allows it". Changed: `Profile` becomes `attributes.profile` (B24) |
| 9 | 196 | access token actions - crud > profiles > createToken refuses a profile the policy does not allow | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): policy-allowed profiles; a refused create persists nothing | T3: authn-token/test/v3/token-service.test.ts "pins a profile only when the policy allows it" (refused `invalid_scope`) and validate "fails a pinned token once its profile is no longer allowed"; authz-rbac/test/ported/token/role-policy.test.ts "RBAC keeps the roles of a token pinned to a profile the policy does not offer; authn-token rejects such a token (crud 9)". Changed: `invalid_scope` replaces `AccessTokenRoleNotAllowed`; RBAC has no profile gate, the gate is in authn-token (B24) |
| 10 | 208 | access token actions - crud > profiles > createToken validates roles against the profile, not the owner union | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): roles validated against the profile-relative set, not the owner union | T3: authz-rbac/test/ported/token/role-policy.test.ts "validates roles against the profile, not the owner union (crud 10, controller-roles 14)". Changed: checked at check time via `TokenRoleRules.allowedRoles`; no profile-relative role check at create time (`RoleSource` takes no profile; open design question) (B24) |
| 11 | 222 | access token actions - crud > profiles > grantTokenRole validates against the profile the token is pinned to | drop | N6 | 3.0 has no token role editing (design §22.9, N6, N8b); profile-relative validation is covered by line 208 | done: deleted |
| 12 | 239 | access token actions - crud > R5: revoking a role the token does not carry emits no event and keeps the row | drop | N6 | 3.0 has no token role editing (design §22.9, N6, N8b); no role revoke event on a token | done: deleted |

Status (N6): rows 1, 3, 8, 9, 10 moved to `legacy-v2/actions-crud.test.ts`; rows 6, 7, 11, 12 deleted (N6 task 0).
N6 task 2: `test/actions-crud.test.ts` deleted; its rows now live in `v3/token-service.test.ts`:
row 2 → `create` "stores the given expiry and CreatedAt from ctx.now, not the db default";
row 4 → `create` "binds the token to the owner row found by users.Uuid";
row 5 → `revoke` "revokes the token with that uuid and stamps RevokedAt from ctx.now".
Row 1 removed from `legacy-v2/`; replaced by `create` "SR-08 token without expiry refused" and
"mints a prefixed token and stores only its hash", and by the kit case "A14 the plaintext is shown once" (`v3/behaviour.test.ts`).
N6 task 2 fix: row 3's create-time half is covered in `v3/token-service.test.ts` (`create` > "roles against a registered RoleSource");
the check-time half is in `authz-rbac/test/ported/token/role-policy.test.ts` (T3).

## test/actions-validate.test.ts

15 tests; dominant class adapt (adapt 8, rewrite 7).

| # | Line | Test | Class | Lane | Target | Status (N6) |
|---|---|---|---|---|---|---|
| 1 | 75 | access token actions - validate & cleanup > validates a good token and returns effective roles | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ + authn-http/test/v3/ (B24, B07): effective roles (token roles ∩ owner roles ∩ policy) are built by the ceiling and RBAC side, not by token validation | T3: authz-rbac/test/ported/token/role-policy.test.ts "keeps only the carried role: admin is held by the owner but not by the token (validate 1)". Changed: effective roles come from the ceiling, not `validateToken().EffectiveRoles` (B24, B07) |
| 2 | 87 | access token actions - validate & cleanup > rejects unknown token | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) | done: `v3/token-service.test.ts` |
| 3 | 92 | access token actions - validate & cleanup > rejects degenerate input as an unknown token | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) | done: `v3/token-service.test.ts` |
| 4 | 102 | access token actions - validate & cleanup > rejects expired token | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) | done: `v3/token-service.test.ts` |
| 5 | 115 | access token actions - validate & cleanup > infinite token (null expiry) validates | rewrite | N6 | authn-token/test/v3/ (A14, SR-08 "token without expiry refused"): a token with no expiry no longer validates; expiry is mandatory and 2.x rows are back-filled (design §22.18) | done: replaced by `create` "SR-08 token without expiry refused" (`v3/token-service.test.ts`) |
| 6 | 121 | access token actions - validate & cleanup > rejects token of deactivated owner | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) | done: `v3/token-service.test.ts` |
| 7 | 130 | access token actions - validate & cleanup > rejects token of soft-deleted owner | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) | done: `v3/token-service.test.ts` |
| 8 | 142 | access token actions - validate & cleanup > rejects token of banned owner | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) | done: `v3/token-service.test.ts` |
| 9 | 153 | access token actions - validate & cleanup > effective roles shrink when user loses a role | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24, B07, B11): roles shrink with the owner assignments; `User.Role` and `revoke(user, role)` are replaced by assignments | T3: authz-rbac/test/ported/token/role-policy.test.ts "shrinks when the owner loses an assignment, with no new token (validate 9)". Changed: `revoke(user, role)` becomes removing the assignment plus a model cache invalidation |
| 10 | 163 | access token actions - validate & cleanup > rejects when intersection is empty | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): empty role intersection; 3.0 builds a principal with no roles (RBAC denies) instead of throwing `AccessTokenRoleNotAllowed` in validation | T3: authz-rbac/test/ported/token/role-policy.test.ts "an empty intersection is a principal with no roles: RBAC denies, nothing throws (validate 10)". Changed: no `AccessTokenRoleNotAllowed`, a principal with no roles (B24) |
| 11 | 186 | access token actions - validate & cleanup > deleteExpiredTokens removes only expired rows | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory). The "live" fixture becomes a far-future expiry, or a pre-back-fill row inserted through the model (A14: no null-expiry row is created any more) | done: `v3/cli.test.ts` |
| 12 | 208 | access token actions - validate & cleanup > touchToken stamps first use and then throttles writes | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory). Status N6 (task 3): replaced by `TokenStrategy`'s last-used stamp (`v3/token-strategy.test.ts`); the 2.x test is deleted | done: `v3/token-strategy.test.ts`; the live 2.x `touchToken` stays untested until N8a removes it with the middleware |
| 13 | 251 | access token actions - validate & cleanup > profiles > rejects a token whose profile the owner no longer passes | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): profile gate of the role policy | T3: authn-token/test/v3/token-service.test.ts validate "fails a pinned token once its profile is no longer allowed"; authz-rbac/test/ported/token/role-policy.test.ts "RBAC keeps the roles when the owner no longer passes the profile; the gate is in authn-token (validate 13)". Changed: the use-time gate is `TokenService.validate`, RBAC adds none (B24) |
| 14 | 264 | access token actions - validate & cleanup > profiles > intersects effective roles against the profile-relative allowed set | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): intersection against the profile-relative allowed set | T3: authz-rbac/test/ported/token/role-policy.test.ts "intersects against the profile-relative set, while the owner-wide set still covers both (validate 14)". Same scenario; fixture: the owner now holds `extra` (D3) |
| 15 | 278 | access token actions - validate & cleanup > profiles > leaves a legacy token without a profile untouched by the profile gate | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): a token without a profile ignores the profile gate | T3: authz-rbac/test/ported/token/role-policy.test.ts "a token without a profile ignores the profile gate (validate 15)". Same scenario; fixture: the owner now holds `extra` (D3) |

Status (N6): rows 1, 5, 9, 10, 13, 14, 15 moved to `legacy-v2/actions-validate.test.ts` (N6 task 0).
N6 task 2: rows 2, 3, 4, 6, 7, 8 deleted from `test/actions-validate.test.ts`; they now live in `v3/token-service.test.ts` (`validate`):
rows 2, 3 → "answers invalid_credentials for unknown and degenerate input without throwing";
row 4 → "answers expired at and after the expiry";
rows 6, 7, 8 → "answers invalid_credentials for a deactivated / soft-deleted / banned owner, on every use" (owner status through `FakeIdentityStore`).
Row 5 removed from `legacy-v2/`; replaced by `create` "SR-08 token without expiry refused" (a null-expiry row answers `expired`).
Row 11 stays in `test/actions-validate.test.ts` (2.x housekeeping API).
N6 task 6: row 11 deleted from `test/actions-validate.test.ts`; it now lives in `v3/cli.test.ts` (`DbTokenService.deleteExpired`):
"deletes rows expired at or before now and revoked rows, keeps live and null-expiry rows" and
"compares against the given now, not the clock of the database".
N6 task 3: row 12 deleted from `test/actions-validate.test.ts`; it now lives in `v3/token-strategy.test.ts`:
`TokenStrategy` > `last-used stamp` (first use stamps, a use inside the interval writes nothing, a use after it writes again;
racing requests write once; a throwing stamp still answers ok) and `DbTokenService.touch`.
Status (R1bc): file deleted with `src/legacy/`; the 6 remaining cases drove the 2.x `createToken`/`validateToken`. The 3.0 path is covered in `v3/token-service.test.ts`, `v3/token-strategy.test.ts` and `v3/cli.test.ts`.
N8c task 3 (after the rebase onto feat 978d391ff): the owner fixtures here are feat's; N8c changed none of them. No row moved.

## test/cli.test.ts

9 tests; dominant class adapt (adapt 6, rewrite 1, drop 2).

| # | Line | Test | Class | Lane | Target | Status (N6) |
|---|---|---|---|---|---|---|
| 1 | 52 | access token cli commands > rbac:token-create creates token for user | rewrite | N6 | authn-token/test/v3/ (A14, SR-08 "token without expiry refused"): with no `--expires` the command refuses or applies the default TTL (N6 decides which); the 2.x assertion of a null `ExpiresAt` changes | done: `v3/cli.test.ts` (default TTL) |
| 2 | 64 | access token cli commands > rbac:token-create honors --expires | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6) | done: `v3/cli.test.ts` |
| 3 | 79 | access token cli commands > rbac:token-create refuses an unparseable --expires without creating anything | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6) | done: `v3/cli.test.ts` |
| 4 | 89 | access token cli commands > rbac:token-create refuses an empty --expires instead of creating an infinite token | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6) | done: `v3/cli.test.ts` |
| 5 | 100 | access token cli commands > rbac:token-delete removes token | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6) | done: `v3/cli.test.ts` |
| 6 | 110 | access token cli commands > rbac:token-delete reports an unknown token instead of rejecting | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6) | done: `v3/cli.test.ts` |
| 7 | 118 | access token cli commands > rbac:token-grant / rbac:token-revoke mutate roles | drop | N6 | N6 task 6 moves only `authn:token-create\|delete\|delete-expired`; the grant/revoke commands are not carried over (3.0 has no token role editing, design §22.9, N8b; see actions-crud line 127) | done: deleted |
| 8 | 131 | access token cli commands > rbac:token-revoke refuses the last role, leaving the row untouched | drop | N6 | last-role refusal of the removed `token-revoke` command; N6 task 6 lists no grant/revoke commands | done: deleted |
| 9 | 152 | access token cli commands > rbac:token-delete-expired removes only expired tokens | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6). The "live" fixture becomes a far-future expiry, or a pre-back-fill row inserted through the model (A14: no null-expiry row is created any more) | done: `v3/cli.test.ts` |

Status (N6): row 1 moved to `legacy-v2/cli.test.ts`; rows 7, 8 deleted (N6 task 0).
N6 task 6: `test/cli.test.ts` and `legacy-v2/cli.test.ts` deleted; the commands are `authn:token-*` on `TokenService`
and their rows live in `v3/cli.test.ts`:
row 1 → `authn:token-create` "applies authn.token.defaultTtlDays from now when --expires is not given" (decision: default TTL, never infinite);
row 2 → "honours --expires"; row 3 → "refuses an unparseable --expires without creating anything";
row 4 → "refuses an empty --expires instead of applying the default";
row 5 → `authn:token-delete` "revokes the token whoever owns it and publishes token.revoke for the owner" (3.0 revokes, it does not delete the row);
row 6 → "reports an unknown or already revoked token instead of rejecting";
row 9 → `authn:token-delete-expired` "removes only expired and revoked tokens and prints the count" (the never-expiring fixture is a pre-back-fill row inserted through the model).
`test/cli-orm-boot.test.ts` checks all three commands against `TokenCliCommand`.

## test/generator.test.ts

4 tests; dominant class adapt (adapt 4).

| # | Line | Test | Class | Lane | Target | Status (N6) |
|---|---|---|---|---|---|---|
| 1 | 19 | SecureRandomTokenProvider > generates prefixed base64url token with matching sha256 hash | adapt | N6 | authn-token/test/ (A14: prefix `spt_`, 256-bit secret, SHA-256 at rest; config keys already `authn.token.*`) | done: kept in `test/generator.test.ts` |
| 2 | 27 | SecureRandomTokenProvider > generates unique tokens | adapt | N6 | authn-token/test/ (A14: prefix `spt_`, 256-bit secret, SHA-256 at rest; config keys already `authn.token.*`) | done: kept in `test/generator.test.ts` |
| 3 | 34 | SecureRandomTokenProvider > hash() is deterministic and matches generate() | adapt | N6 | authn-token/test/ (A14: prefix `spt_`, 256-bit secret, SHA-256 at rest; config keys already `authn.token.*`) | done: kept in `test/generator.test.ts` |
| 4 | 90 | SecureRandomTokenProvider config wiring > resolved through DI honours authn.token.prefix / authn.token.length | adapt | N6 | authn-token/test/ (A14: prefix `spt_`, 256-bit secret, SHA-256 at rest; config keys already `authn.token.*`). The fixture sets `authn.token.length: 16` (128 bits), below the 256-bit floor of A14; if N6 enforces the floor, the fixture value and the expected 22-char length change | done: kept in `test/generator.test.ts` |

Status (N6): row 4's fixture sets `length: 48` (64 chars), so the test proves the configured length is read (N6 task 2). New: "refuses to mint with an empty prefix or fewer than 32 bytes".

## test/model.test.ts

5 tests; dominant class adapt (adapt 5).

| # | Line | Test | Class | Lane | Target | Status (N6) |
|---|---|---|---|---|---|---|
| 1 | 45 | AccessToken model > persists and loads a token with roles set and null expiry | adapt | N6 | authn-token/test/ (model and table `rbac_access_tokens` kept, design §22.9; owner fixture through the `users` factory). If N6 makes `ExpiresAt` NOT NULL (the back-fill alone does not), this row becomes a rewrite | done: kept in `test/model.test.ts`; `ExpiresAt` stays nullable (2.x rows before the back-fill) |
| 2 | 65 | AccessToken model > IsExpired is true for past ExpiresAt | adapt | N6 | authn-token/test/ (model and table `rbac_access_tokens` kept, design §22.9; owner fixture through the `users` factory) | done: kept in `test/model.test.ts` |
| 3 | 80 | AccessToken model > hides hash, ids and owner when dehydrated | adapt | N6 | authn-token/test/ (model and table `rbac_access_tokens` kept, design §22.9; owner fixture through the `users` factory) | done: kept in `test/model.test.ts` |
| 4 | 99 | AccessToken model > persists and loads the Profile column | adapt | N6 | authn-token/test/ (model and table `rbac_access_tokens` kept, design §22.9; owner fixture through the `users` factory) | done: kept in `test/model.test.ts` |
| 5 | 113 | AccessToken model > leaves Profile undefined for legacy rows | adapt | N6 | authn-token/test/ (model and table `rbac_access_tokens` kept, design §22.9; owner fixture through the `users` factory) | done: kept in `test/model.test.ts` |

Status (N8c task 3, after the rebase onto feat 978d391ff): rows 1-5 stay with feat's owner fixtures; N8c changed none.

## test/role-policy-actions.test.ts

8 tests; dominant class rewrite (rewrite 7, drop 1).

| # | Line | Test | Class | Lane | Target | Status (N6) |
|---|---|---|---|---|---|---|
| 1 | 85 | access token actions - role policy > creates a token with a role the owner does not literally hold | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): the token role policy applies inside RBAC (C5); the AccessControl grants map is gone. OPEN: B24/B07 (never above the owner) vs design §18.3(g) (role allowed when the owner's grants cover it); C5 or the integrator decides before T3 ports these rows | T3: authz-rbac/test/ported/token/role-policy.test.ts "does not put it on the token: never above the owner (policy-actions 1; ...)". Changed: the policy cannot grant a role the owner lacks (B07, B24, item 16 / r6 D3 / 18.3(g)) |
| 2 | 94 | access token actions - role policy > refuses a role the policy does not allow | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): the token role policy applies inside RBAC (C5); the AccessControl grants map is gone | T3: authz-rbac/test/ported/token/role-policy.test.ts "refuses a role the policy does not allow; the same owner via session keeps it (policy-actions 2)". Changed: refusal at create becomes the role dropping at check time (B24) |
| 3 | 107 | access token actions - role policy > grants a role the policy allows | drop | N6 | 3.0 has no token role editing (design §22.9, N6, N8b); the policy-allowed role is covered by line 85 | done: deleted |
| 4 | 117 | access token actions - role policy > authenticates with the effective roles the policy still allows | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): the token role policy applies inside RBAC (C5); the AccessControl grants map is gone. OPEN: B24/B07 (never above the owner) vs design §18.3(g) (role allowed when the owner's grants cover it); C5 or the integrator decides before T3 ports these rows | T3: authz-rbac/test/ported/token/role-policy.test.ts "follows a policy that narrows after the token was made (policy-actions 4)". Changed: only the owner-lacks part (see row 1) |
| 5 | 131 | access token actions - role policy > refuses a token whose roles the policy no longer allows at all | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): the token role policy applies inside RBAC (C5); the AccessControl grants map is gone | T3: authz-rbac/test/ported/token/role-policy.test.ts "a policy that allows nothing leaves a principal with no roles and denies, without throwing (policy-actions 5)". Changed: no throw, RBAC denies (B24) |
| 6 | 156 | access token actions - role policy > never puts a role the policy returns but AccessControl does not know onto a token | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24, B02): a role the policy returns but RBAC does not know never reaches a token | T3: authz-rbac/test/ported/token/role-policy.test.ts "a role the policy returns but RBAC does not know never reaches the token (policy-actions 6)". Changed: no throw, the unknown role is cut (B24, B02) |
| 7 | 178 | access token actions - role policy > never lets a prototype-chain property name through as an allowed role | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24, B02): prototype-chain names (`constructor`, `__proto__`) are never roles; keep this guard against a policy-supplied name with the new role lookup | T3: authz-rbac/test/ported/token/role-policy.test.ts "prototype-chain names are never roles (policy-actions 7)". Same intent (B24, B02) |
| 8 | 188 | access token actions - role policy > never puts a policy-returned unknown role into EffectiveRoles | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24, B02): a policy-returned unknown role never enters the effective roles | T3: authz-rbac/test/ported/token/role-policy.test.ts "a role the policy starts to return later never enters the effective roles (policy-actions 8)". Same intent |

Status (N6): file moved to `legacy-v2/role-policy-actions.test.ts` with rows 1, 2, 4-8; row 3 deleted (N6 task 0).

T3: `role-policy-name-clash.test.ts` (2 `it`s, no row above) dropped: it tested two same-named policy classes coexisting; R1 removes the legacy class. 3.0 side: `authz-rbac/test/token/rules.test.ts` "defaults to no excluded roles and OwnRolesTokenRolePolicy".
Status (R1bc): `src/legacy/` is deleted, so the 2.x role policy these rows tested is gone.

## test/role-policy.test.ts

8 tests; dominant class adapt (move 4, adapt 4).

| # | Line | Test | Class | Lane | Target | Status (N6) |
|---|---|---|---|---|---|---|
| 1 | 42 | access token role policy - defaults > OwnRolesTokenRolePolicy > allows exactly the roles the owner holds | adapt | C5 | authz-rbac/test/token/ (`authz.token.rolePolicy`, B24; owner roles seeded as assignments, H13, instead of `new User({ Role })`) | done (C5): moved to `authz-rbac/test/token/rules.test.ts` > OwnRolesTokenRolePolicy > allows exactly the roles the owner holds (owner roles seeded as RBAC assignments, read with `RbacService.rolesOf`) |
| 2 | 49 | access token role policy - defaults > OwnRolesTokenRolePolicy > allows nothing for an owner with no roles | adapt | C5 | authz-rbac/test/token/ (`authz.token.rolePolicy`, B24; owner roles seeded as assignments, H13, instead of `new User({ Role })`) | done (C5): moved to `authz-rbac/test/token/rules.test.ts` > OwnRolesTokenRolePolicy > allows nothing for an owner with no roles (owner roles seeded as RBAC assignments, read with `RbacService.rolesOf`) |
| 3 | 63 | access token role policy - defaults > OwnRolesTokenRolePolicy > ignores the profile argument - answer stays the owner roles | adapt | C5 | authz-rbac/test/token/ (`authz.token.rolePolicy`, B24; owner roles seeded as assignments, H13, instead of `new User({ Role })`) | done (C5): moved to `authz-rbac/test/token/rules.test.ts` > OwnRolesTokenRolePolicy > ignores the profile argument - answer stays the owner roles (owner roles seeded as RBAC assignments, read with `RbacService.rolesOf`) |
| 4 | 70 | access token role policy - defaults > OwnRolesTokenRolePolicy > offers no profiles by default - the feature is opt-in per application | adapt | C5 | authz-rbac/test/token/ (`authz.token.rolePolicy`, B24; owner roles seeded as assignments, H13, instead of `new User({ Role })`) | done (C5): moved to `authz-rbac/test/token/rules.test.ts` > OwnRolesTokenRolePolicy > offers no profiles by default - the feature is opt-in per application (owner roles seeded as RBAC assignments, read with `RbacService.rolesOf`) |
| 5 | 79 | access token role policy - defaults > _role_excluded > matches an exact name | move | C5 | authz-rbac/test/token/ (the `excludedRoles` matcher applies in `rolesOf`/`covers`, C5 task 1; pure function, assertions unchanged). Keeps the dot-boundary prefix semantics; if C5 reuses the core `wildcard`/`glob` matcher (B16), line 89 must still pass | done (C5): moved to `authz-rbac/test/token/rules.test.ts` > roleExcluded > matches an exact name (assertions unchanged) |
| 6 | 84 | access token role policy - defaults > _role_excluded > matches a prefix pattern and everything under it | move | C5 | authz-rbac/test/token/ (same function, unchanged assertions) | done (C5): moved to `authz-rbac/test/token/rules.test.ts` > roleExcluded > matches a prefix pattern and everything under it (assertions unchanged) |
| 7 | 89 | access token role policy - defaults > _role_excluded > does not treat the prefix as a bare string match | move | C5 | authz-rbac/test/token/ (same function, unchanged assertions) | done (C5): moved to `authz-rbac/test/token/rules.test.ts` > roleExcluded > does not treat the prefix as a bare string match (assertions unchanged) |
| 8 | 95 | access token role policy - defaults > _role_excluded > excludes nothing when no patterns are given | move | C5 | authz-rbac/test/token/ (same function, unchanged assertions) | done (C5): moved to `authz-rbac/test/token/rules.test.ts` > roleExcluded > excludes nothing when no patterns are given (assertions unchanged) |

Status (C5): rows 1-8 moved to `authz-rbac/test/token/rules.test.ts`; file deleted (C5 task 4). The 2.x `_role_excluded` and `LegacyOwnRolesTokenRolePolicy` stay in `src/legacy/` until R1.
Status (R1bc): `src/legacy/` is deleted; `_role_excluded` and `LegacyOwnRolesTokenRolePolicy` are gone.
