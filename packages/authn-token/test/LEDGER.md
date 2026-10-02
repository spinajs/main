# Test ledger: @spinajs/authn-token

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

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 72 | access token actions - crud > creates token for user, returns plaintext once, stores only hash | rewrite | N6 | authn-token/test/v3/ (TokenService.create; A14; SR-08 "token without expiry refused"): expiry is mandatory, so the null `ExpiresAt` assertion changes; the plaintext-once and hash-only assertions keep |
| 2 | 88 | access token actions - crud > accepts expiration date | adapt | N6 | authn-token/test/ (TokenService; owner fixture through the `users` factory) |
| 3 | 97 | access token actions - crud > rejects roles the owner does not hold | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24, B07): the roles-subset rule leaves authn-token (it imports no authz); owner roles come from RBAC assignments, not `User.Role`. OPEN (N6/C5): the create-time refusal (`AccessTokenRoleNotAllowed`, nothing persisted) either survives in 3.0 through `RoleSource`, or becomes narrowing at evaluation only (B07); the replacement follows that decision |
| 4 | 111 | access token actions - crud > resolves owner by uuid string | adapt | N6 | authn-token/test/ (TokenService; owner fixture through the `users` factory) |
| 5 | 118 | access token actions - crud > deletes token by uuid | adapt | N6 | authn-token/test/ (TokenService; owner fixture through the `users` factory) |
| 6 | 127 | access token actions - crud > grants and revokes role on token, only owner-held roles grantable | drop | N6 | 3.0 has no token role editing (design §22.9, N6, N8b); the owner-held-roles rule is covered by line 97 |
| 7 | 147 | access token actions - crud > refuses to revoke the last role, leaving the row untouched | drop | N6 | 3.0 has no token role editing (design §22.9, N6, N8b); no role editing, so no last-role refusal; the empty-role guard at creation is covered by line 97 |
| 8 | 184 | access token actions - crud > profiles > createToken stores the profile when the policy allows it | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): profile pin and `authz.token.rolePolicy` replace the `rbac.token.rolePolicy` seam; `Profile` becomes `attributes.profile` |
| 9 | 196 | access token actions - crud > profiles > createToken refuses a profile the policy does not allow | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): policy-allowed profiles; a refused create persists nothing |
| 10 | 208 | access token actions - crud > profiles > createToken validates roles against the profile, not the owner union | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): roles validated against the profile-relative set, not the owner union |
| 11 | 222 | access token actions - crud > profiles > grantTokenRole validates against the profile the token is pinned to | drop | N6 | 3.0 has no token role editing (design §22.9, N6, N8b); profile-relative validation is covered by line 208 |
| 12 | 239 | access token actions - crud > R5: revoking a role the token does not carry emits no event and keeps the row | drop | N6 | 3.0 has no token role editing (design §22.9, N6, N8b); no role revoke event on a token |

## test/actions-validate.test.ts

15 tests; dominant class adapt (adapt 8, rewrite 7).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 75 | access token actions - validate & cleanup > validates a good token and returns effective roles | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ + authn-http/test/v3/ (B24, B07): effective roles (token roles ∩ owner roles ∩ policy) are built by the ceiling and RBAC side, not by token validation |
| 2 | 87 | access token actions - validate & cleanup > rejects unknown token | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) |
| 3 | 92 | access token actions - validate & cleanup > rejects degenerate input as an unknown token | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) |
| 4 | 102 | access token actions - validate & cleanup > rejects expired token | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) |
| 5 | 115 | access token actions - validate & cleanup > infinite token (null expiry) validates | rewrite | N6 | authn-token/test/v3/ (A14, SR-08 "token without expiry refused"): a token with no expiry no longer validates; expiry is mandatory and 2.x rows are back-filled (design §22.18) |
| 6 | 121 | access token actions - validate & cleanup > rejects token of deactivated owner | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) |
| 7 | 130 | access token actions - validate & cleanup > rejects token of soft-deleted owner | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) |
| 8 | 142 | access token actions - validate & cleanup > rejects token of banned owner | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) |
| 9 | 153 | access token actions - validate & cleanup > effective roles shrink when user loses a role | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24, B07, B11): roles shrink with the owner assignments; `User.Role` and `revoke(user, role)` are replaced by assignments |
| 10 | 163 | access token actions - validate & cleanup > rejects when intersection is empty | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): empty role intersection; 3.0 builds a principal with no roles (RBAC denies) instead of throwing `AccessTokenRoleNotAllowed` in validation |
| 11 | 186 | access token actions - validate & cleanup > deleteExpiredTokens removes only expired rows | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory). The "live" fixture becomes a far-future expiry, or a pre-back-fill row inserted through the model (A14: no null-expiry row is created any more) |
| 12 | 208 | access token actions - validate & cleanup > touchToken stamps first use and then throttles writes | adapt | N6 | authn-token/test/ (TokenService.validate, A14; owner fixture through the `users` factory) |
| 13 | 251 | access token actions - validate & cleanup > profiles > rejects a token whose profile the owner no longer passes | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): profile gate of the role policy |
| 14 | 264 | access token actions - validate & cleanup > profiles > intersects effective roles against the profile-relative allowed set | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): intersection against the profile-relative allowed set |
| 15 | 278 | access token actions - validate & cleanup > profiles > leaves a legacy token without a profile untouched by the profile gate | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): a token without a profile ignores the profile gate |

## test/cli.test.ts

9 tests; dominant class adapt (adapt 6, rewrite 1, drop 2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 52 | access token cli commands > rbac:token-create creates token for user | rewrite | N6 | authn-token/test/v3/ (A14, SR-08 "token without expiry refused"): with no `--expires` the command refuses or applies the default TTL (N6 decides which); the 2.x assertion of a null `ExpiresAt` changes |
| 2 | 64 | access token cli commands > rbac:token-create honors --expires | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6) |
| 3 | 79 | access token cli commands > rbac:token-create refuses an unparseable --expires without creating anything | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6) |
| 4 | 89 | access token cli commands > rbac:token-create refuses an empty --expires instead of creating an infinite token | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6) |
| 5 | 100 | access token cli commands > rbac:token-delete removes token | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6) |
| 6 | 110 | access token cli commands > rbac:token-delete reports an unknown token instead of rejecting | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6) |
| 7 | 118 | access token cli commands > rbac:token-grant / rbac:token-revoke mutate roles | drop | N6 | N6 task 6 moves only `authn:token-create\|delete\|delete-expired`; the grant/revoke commands are not carried over (3.0 has no token role editing, design §22.9, N8b; see actions-crud line 127) |
| 8 | 131 | access token cli commands > rbac:token-revoke refuses the last role, leaving the row untouched | drop | N6 | last-role refusal of the removed `token-revoke` command; N6 task 6 lists no grant/revoke commands |
| 9 | 152 | access token cli commands > rbac:token-delete-expired removes only expired tokens | adapt | N6 | authn-token/test/ (command renamed `rbac:token-*` to `authn:token-*`, N6 task 6). The "live" fixture becomes a far-future expiry, or a pre-back-fill row inserted through the model (A14: no null-expiry row is created any more) |

## test/generator.test.ts

4 tests; dominant class adapt (adapt 4).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 19 | SecureRandomTokenProvider > generates prefixed base64url token with matching sha256 hash | adapt | N6 | authn-token/test/ (A14: prefix `spt_`, 256-bit secret, SHA-256 at rest; config keys already `authn.token.*`) |
| 2 | 27 | SecureRandomTokenProvider > generates unique tokens | adapt | N6 | authn-token/test/ (A14: prefix `spt_`, 256-bit secret, SHA-256 at rest; config keys already `authn.token.*`) |
| 3 | 34 | SecureRandomTokenProvider > hash() is deterministic and matches generate() | adapt | N6 | authn-token/test/ (A14: prefix `spt_`, 256-bit secret, SHA-256 at rest; config keys already `authn.token.*`) |
| 4 | 90 | SecureRandomTokenProvider config wiring > resolved through DI honours authn.token.prefix / authn.token.length | adapt | N6 | authn-token/test/ (A14: prefix `spt_`, 256-bit secret, SHA-256 at rest; config keys already `authn.token.*`). The fixture sets `authn.token.length: 16` (128 bits), below the 256-bit floor of A14; if N6 enforces the floor, the fixture value and the expected 22-char length change |

## test/model.test.ts

5 tests; dominant class adapt (adapt 5).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 45 | AccessToken model > persists and loads a token with roles set and null expiry | adapt | N6 | authn-token/test/ (model and table `rbac_access_tokens` kept, design §22.9; owner fixture through the `users` factory). If N6 makes `ExpiresAt` NOT NULL (the back-fill alone does not), this row becomes a rewrite |
| 2 | 65 | AccessToken model > IsExpired is true for past ExpiresAt | adapt | N6 | authn-token/test/ (model and table `rbac_access_tokens` kept, design §22.9; owner fixture through the `users` factory) |
| 3 | 80 | AccessToken model > hides hash, ids and owner when dehydrated | adapt | N6 | authn-token/test/ (model and table `rbac_access_tokens` kept, design §22.9; owner fixture through the `users` factory) |
| 4 | 99 | AccessToken model > persists and loads the Profile column | adapt | N6 | authn-token/test/ (model and table `rbac_access_tokens` kept, design §22.9; owner fixture through the `users` factory) |
| 5 | 113 | AccessToken model > leaves Profile undefined for legacy rows | adapt | N6 | authn-token/test/ (model and table `rbac_access_tokens` kept, design §22.9; owner fixture through the `users` factory) |

## test/role-policy-actions.test.ts

8 tests; dominant class rewrite (rewrite 7, drop 1).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 85 | access token actions - role policy > creates a token with a role the owner does not literally hold | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): the token role policy applies inside RBAC (C5); the AccessControl grants map is gone. OPEN: B24/B07 (never above the owner) vs design §18.3(g) (role allowed when the owner's grants cover it); C5 or the integrator decides before T3 ports these rows |
| 2 | 94 | access token actions - role policy > refuses a role the policy does not allow | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): the token role policy applies inside RBAC (C5); the AccessControl grants map is gone |
| 3 | 107 | access token actions - role policy > grants a role the policy allows | drop | N6 | 3.0 has no token role editing (design §22.9, N6, N8b); the policy-allowed role is covered by line 85 |
| 4 | 117 | access token actions - role policy > authenticates with the effective roles the policy still allows | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): the token role policy applies inside RBAC (C5); the AccessControl grants map is gone. OPEN: B24/B07 (never above the owner) vs design §18.3(g) (role allowed when the owner's grants cover it); C5 or the integrator decides before T3 ports these rows |
| 5 | 131 | access token actions - role policy > refuses a token whose roles the policy no longer allows at all | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24): the token role policy applies inside RBAC (C5); the AccessControl grants map is gone |
| 6 | 156 | access token actions - role policy > never puts a role the policy returns but AccessControl does not know onto a token | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24, B02): a role the policy returns but RBAC does not know never reaches a token |
| 7 | 178 | access token actions - role policy > never lets a prototype-chain property name through as an allowed role | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24, B02): prototype-chain names (`constructor`, `__proto__`) are never roles; keep this guard against a policy-supplied name with the new role lookup |
| 8 | 188 | access token actions - role policy > never puts a policy-returned unknown role into EffectiveRoles | rewrite | N6 -> T3 | authz-rbac/test/ported/token/ (B24, B02): a policy-returned unknown role never enters the effective roles |

## test/role-policy.test.ts

8 tests; dominant class adapt (move 4, adapt 4).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 42 | access token role policy - defaults > OwnRolesTokenRolePolicy > allows exactly the roles the owner holds | adapt | C5 | authz-rbac/test/token/ (`authz.token.rolePolicy`, B24; owner roles seeded as assignments, H13, instead of `new User({ Role })`) |
| 2 | 49 | access token role policy - defaults > OwnRolesTokenRolePolicy > allows nothing for an owner with no roles | adapt | C5 | authz-rbac/test/token/ (`authz.token.rolePolicy`, B24; owner roles seeded as assignments, H13, instead of `new User({ Role })`) |
| 3 | 63 | access token role policy - defaults > OwnRolesTokenRolePolicy > ignores the profile argument - answer stays the owner roles | adapt | C5 | authz-rbac/test/token/ (`authz.token.rolePolicy`, B24; owner roles seeded as assignments, H13, instead of `new User({ Role })`) |
| 4 | 70 | access token role policy - defaults > OwnRolesTokenRolePolicy > offers no profiles by default - the feature is opt-in per application | adapt | C5 | authz-rbac/test/token/ (`authz.token.rolePolicy`, B24; owner roles seeded as assignments, H13, instead of `new User({ Role })`) |
| 5 | 79 | access token role policy - defaults > _role_excluded > matches an exact name | move | C5 | authz-rbac/test/token/ (the `excludedRoles` matcher applies in `rolesOf`/`covers`, C5 task 1; pure function, assertions unchanged). Keeps the dot-boundary prefix semantics; if C5 reuses the core `wildcard`/`glob` matcher (B16), line 89 must still pass |
| 6 | 84 | access token role policy - defaults > _role_excluded > matches a prefix pattern and everything under it | move | C5 | authz-rbac/test/token/ (same function, unchanged assertions) |
| 7 | 89 | access token role policy - defaults > _role_excluded > does not treat the prefix as a bare string match | move | C5 | authz-rbac/test/token/ (same function, unchanged assertions) |
| 8 | 95 | access token role policy - defaults > _role_excluded > excludes nothing when no patterns are given | move | C5 | authz-rbac/test/token/ (same function, unchanged assertions) |
