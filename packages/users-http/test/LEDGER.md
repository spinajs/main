# Test ledger: @spinajs/users-http

Every `it` of the 2.x suite of this package at `3d22b6c8f`, classified per
plan §1 rule 6 (F5). Classes: move, adapt, rewrite, drop (definitions:
`.authz-sdd/F5-task-7-brief.md` → kept in the header below).
Rewrite-class files go to `test/legacy-v2/` in their C/N lane; the T lane
replaces them and deletes the legacy file.

- **move**: the test's code and assertions stay as they are; only the file moves to another package because the code under test moves there.
- **adapt**: the test stays with mechanical edits (renamed imports, config keys, roles seeded as assignments, a route that keeps its contract) that keep its intent and expected values.
- **rewrite**: the test asserts 2.x authorization or authentication behaviour that 3.0 replaces; the owning lane moves it to `test/legacy-v2/` and a T or N lane writes the 3.0 replacement under the named B or A rules.
- **drop**: the test has no 3.0 counterpart; the reason is in the Target column.

Departure from plan T2: T2 sends the `controller-override` suite to `authn-http/test/v3/`. `UserController` lives in users-http (C2 task 1, design §4.1.1), and plan §1 rule 10 and D26 bar any `users` or `authz*` dependency in an `authn*` package, so the three rows target `users-http/test/v3/`.

Rewrites marked `C2 → C2` in `users-controller.test.ts` and `z-controller-refresh.test.ts`: no T lane in plan §5 owns these; C2 writes the replacements (to be confirmed by the integrator).

Note: 12 tests of `users-controller.test.ts` (most likely the `addUser` cases that create an account) fail on the base because `invite.ttlSeconds` is missing from the test config; they are classified by intent like the rest.

The `Now` column records the state after plan C2 (C2 tasks 0 and 6) and C2b task 1 (`GET /user` on `@Access`); rows waiting on N8a keep their 2.x tests until the routes move onto `@Access`.

| Class | Count |
|---|---|
| move | 0 |
| adapt | 95 |
| rewrite | 51 |
| drop | 4 |
| **total** | 150 |

## test/controller-override.test.ts

An application subclasses `UserController` and registers it as the base; dominant class rewrite (C2, then T2 per plan, in `users-http/test/v3/`).

| # | Line | Test | Class | Lane | Target | Now |
|---|---|---|---|---|---|---|
| 1 | 142 | controller override end to end > routes the overridden action to the application controller | rewrite | C2 → T2 | users-http/test/v3/ per plan T2 (stubs of RbacPolicy, RbacMiddleware, AuthorizedPolicy replaced; B23); `UserController` lives in users-http (C2 task 1, design §4.1.1), so the suite cannot sit in authn-http (rule 10, D26) | legacy-v2: test/legacy-v2/controller-override.test.ts (C2b task 1: it stubs the 2.x policies and asserts `getGrants`, which 3.0 removes; T2 rewrites it on test/support/http-app.ts) |
| 2 | 149 | controller override end to end > mounts the application controller, not the package one | rewrite | C2 → T2 | users-http/test/v3/ per plan T2 (override mounting kept; setup rewritten); `UserController` lives in users-http, not authn-http (rule 10, D26) | legacy-v2: test/legacy-v2/controller-override.test.ts (C2b task 1: it stubs the 2.x policies and asserts `getGrants`, which 3.0 removes; T2 rewrites it on test/support/http-app.ts) |
| 3 | 156 | controller override end to end > still exposes a route the override did not redeclare | rewrite | C2 → T2 | users-http/test/v3/ per plan T2 (the `getGrants` route is gone; check another inherited profile route instead, since `GET /user/access` (B25) belongs to authz-http `AccessController`, not `UserController`); `UserController` lives in users-http (rule 10, D26) | legacy-v2: test/legacy-v2/controller-override.test.ts (C2b task 1: it stubs the 2.x policies and asserts `getGrants`, which 3.0 removes; T2 rewrites it on test/support/http-app.ts) |

## test/no-direct-user-statics.test.ts

Source lint that admin controllers never call `User` statics directly; dropped (scoping moves into the ORM).

| # | Line | Test | Class | Lane | Target | Now |
|---|---|---|---|---|---|---|
| 1 | 14 | no direct User static queries in admin controllers > file | drop | C2 | 2.x row scoping went through the `RbacUserModel` token (`userModel()`); in 3.0 the ORM scopes every query on an `@AccessResource` model (B20, B21), so a source lint for direct `User.*` statics has no counterpart; users-controller row 1098 (`list is row-scoped`, B20) carries the intent | kept: test/no-direct-user-statics.test.ts (drop row, test still present) |

## test/route-contract.test.ts

Route descriptors (permissions, verbs) and DTO body schemas of the admin controllers; authorization and verb checks rewrite (C2, then T3), DTO schema checks adapt.

| # | Line | Test | Class | Lane | Target | Now |
|---|---|---|---|---|---|---|
| 1 | 70 | Admin route contract > authorization > every admin route declares a permission | rewrite | C2 → T3 | users-http/test/v3/ (B23: every route carries `@Access`; reads the new descriptor) | kept: test/route-contract.test.ts (2.x decorators, stays until C2b moves the controllers; R1 deletes it); T3: skipped BUG(T3), test/v3/route-contract-access.test.ts "every route of Users, Security and Profile carries @Access". Changed: `@Permission`/RbacPolicy becomes `@Access` read through `accessDescriptorOf` (B23); goes live when C2b moves the controllers |
| 2 | 86 | Admin route contract > authorization > every admin route is bound to the users resource | rewrite | C2 → T3 | users-http/test/v3/ (B23: the route check is `@Access` with the `users` type; `@AccessResource` is a model decorator and B21 is about models) | kept: test/route-contract.test.ts (2.x decorators, stays until C2b moves the controllers; R1 deletes it); T3: skipped BUG(T3), test/v3/route-contract-access.test.ts "every @Access names the users type". Changed: each permission of the rule parses to resource `users` instead of `@Resource` (B23) |
| 3 | 101 | Admin route contract > authorization > write routes keep their :any permission alongside :own | rewrite | C2 → T3 | users-http/test/v3/ (B23, B15: `:any`/`:own` pairs become one permission with an owner relation) | kept: test/route-contract.test.ts (2.x decorators, stays until C2b moves the controllers; R1 deletes it); T3: skipped BUG(T3), test/v3/route-contract-access.test.ts "write routes keep the any-case: one plain permission, no owner-only variant". Changed: the `:any`/`:own` pair is one permission, the owner relation lives on the role grant (B23, B15) |
| 4 | 128 | Admin route contract > http verbs > no state-changing route answers GET | rewrite | C2 → T3 | users-http/test/v3/ and authz-http-admin/test/ (B23; verb check kept; the controller list changes as Roles and credential routes move) | kept: test/route-contract.test.ts; T3: test/v3/route-contract-access.test.ts "http verbs > no state-changing route answers GET"; AuthzAdmin twin: authz-http-admin/test/route-verbs.test.ts. Same check, read-only name list unchanged |
| 5 | 150 | Admin route contract > body schemas > accepts a partial update | adapt | C2 | users-http/test/ (DTO schema checks; plan T3 lists the file whole, see report) | kept: test/route-contract.test.ts |
| 6 | 156 | Admin route contract > body schemas > rejects an update carrying fields this endpoint does not manage | adapt | C2 | users-http/test/ (DTO schema checks; plan T3 lists the file whole, see report) | kept: test/route-contract.test.ts |
| 7 | 162 | Admin route contract > body schemas > still requires the full set of fields on creation | adapt | C2 | users-http/test/ (DTO schema checks; plan T3 lists the file whole, see report) | kept: test/route-contract.test.ts |
| 8 | 167 | Admin route contract > body schemas > rejects a malformed email on creation | adapt | C2 | users-http/test/ (DTO schema checks; plan T3 lists the file whole, see report) | kept: test/route-contract.test.ts |
| 9 | 171 | Admin route contract > body schemas > accepts one role name or a list of them | adapt | C2 | users-http/test/ (DTO schema checks; plan T3 lists the file whole, see report) | kept: test/route-contract.test.ts |
| 10 | 184 | Admin route contract > body schemas > refuses a role list that names no role | adapt | C2 | users-http/test/ (DTO schema checks; plan T3 lists the file whole, see report) | kept: test/route-contract.test.ts |
| 11 | 198 | Admin route contract > body schemas > refuses padded and duplicated role names | adapt | C2 | users-http/test/ (DTO schema checks; plan T3 lists the file whole, see report) | kept: test/route-contract.test.ts |
| 12 | 204 | Admin route contract > body schemas > refuses more roles than one account may be given | adapt | C2 | users-http/test/ (DTO schema checks; plan T3 lists the file whole, see report) | kept: test/route-contract.test.ts |

## test/user-controller-db.test.ts

The "my account" controller against SQLite: refresh, grants, own password change; dominant class rewrite (C2, then T2).

| # | Line | Test | Class | Lane | Target | Now |
|---|---|---|---|---|---|---|
| 1 | 105 | UserController (database backed) > refresh > returns the current user without the password hash | adapt | C2 | users-http/test/ (plan T2 lists the suite whole under users-http/test/v3; roles seeded as assignments, H13) | replaced (C2b task 1): test/v3/user-profile.test.ts `never answers Password or Id, even to a role that reads every field of its own record` |
| 2 | 114 | UserController (database backed) > refresh > reloads values that changed in the database behind the request | adapt | C2 | users-http/test/ (plan T2 lists the suite whole under users-http/test/v3; roles seeded as assignments, H13) | replaced (C2b task 1): test/v3/user-profile.test.ts `reads the record again on every request: a change behind the session shows at once` |
| 3 | 125 | UserController (database backed) > refresh > writes the user uuid into the session so the next request still resolves the user | rewrite | C2 → T2 | users-http/test/v3/ (A07, A23: the session carries identity through authn-session, not `Data.User`); same intent as z-controller-refresh 57, one replacement test covers both | replaced (C2b task 1, not T2): test/v3/user-profile.test.ts `keeps resolving the same user on the next request with the same session` |
| 4 | 148 | UserController (database backed) > getGrants > returns the grants of the roles the user has | rewrite | C2 → T2 | users-http/test/v3/ (B25: the grants route is replaced by `GET /user/access`; B11, B24 ceiling.roles for the active role) | legacy-v2: test/legacy-v2/user-controller-db.test.ts |
| 5 | 157 | UserController (database backed) > getGrants > does not leak grants of roles the user does not have | rewrite | C2 → T2 | users-http/test/v3/ (B25: the grants route is replaced by `GET /user/access`; B11, B24 ceiling.roles for the active role) | legacy-v2: test/legacy-v2/user-controller-db.test.ts |
| 6 | 164 | UserController (database backed) > getGrants > falls back to the first assigned role when the session names no active role | rewrite | C2 → T2 | users-http/test/v3/ (B25: the grants route is replaced by `GET /user/access`; B11, B24, D14: no first-role fallback, without `ceiling.roles` every held role applies, so the 3.0 expectation differs) | legacy-v2: test/legacy-v2/user-controller-db.test.ts |
| 7 | 170 | UserController (database backed) > getGrants > reports only the active role — not the union of every assigned role | rewrite | C2 → T2 | users-http/test/v3/ (B25: the grants route is replaced by `GET /user/access`; B11, B24 ceiling.roles for the active role) | legacy-v2: test/legacy-v2/user-controller-db.test.ts |
| 8 | 197 | UserController (database backed) > newPassword > changes the password when the old one matches | rewrite | C2 → T2 | authn-http/test/v3/ (A13 fresh auth, A04; `PATCH /user/password`, N8b) | legacy-v2: test/legacy-v2/user-controller-db.test.ts |
| 9 | 209 | UserController (database backed) > newPassword > destroys every session opened with the old password | rewrite | C2 → T2 | authn-http/test/v3/ (A30, A08: other sessions revoked, current rotated, tokens kept; 2.x destroyed all) | legacy-v2: test/legacy-v2/user-controller-db.test.ts |
| 10 | 222 | UserController (database backed) > newPassword > issues a fresh session for the caller so the password change does not log them out | rewrite | C2 → T2 | authn-http/test/v3/ (A30, A08: other sessions revoked, current rotated, tokens kept; 2.x destroyed all) | legacy-v2: test/legacy-v2/user-controller-db.test.ts |
| 11 | 239 | UserController (database backed) > newPassword > rejects when the confirmation does not match | rewrite | C2 → T2 | authn-http/test/v3/ (A04, A13: `PATCH /user/password` rules; a failed re-auth counts into the throttle) | legacy-v2: test/legacy-v2/user-controller-db.test.ts |
| 12 | 247 | UserController (database backed) > newPassword > rejects when the old password is wrong | rewrite | C2 → T2 | authn-http/test/v3/ (A04, A13: `PATCH /user/password` rules; a failed re-auth counts into the throttle) | legacy-v2: test/legacy-v2/user-controller-db.test.ts |

## test/user-metadata-controller.test.ts

Own and admin metadata routes with owner scoping and the protected-key guard; all adapt in C2, keeping the SEC1 guard.

| # | Line | Test | Class | Lane | Target | Now |
|---|---|---|---|---|---|---|
| 1 | 115 | UserMetadataController > own metadata — read > lists the metadata of the authenticated user | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 2 | 123 | UserMetadataController > own metadata — read > never lists metadata belonging to somebody else | adapt | C2 | users-http/test/ (IDOR intent kept: owner scoping through the `self` relation, B15) | kept: test/user-metadata-controller.test.ts |
| 3 | 129 | UserMetadataController > own metadata — read > lists metadata when no pagination is supplied | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 4 | 138 | UserMetadataController > own metadata — read > paginates | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 5 | 147 | UserMetadataController > own metadata — read > orders by the requested column | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 6 | 153 | UserMetadataController > own metadata — read > returns a single own entry by key | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 7 | 159 | UserMetadataController > own metadata — read > does not return another user entry by key | adapt | C2 | users-http/test/ (IDOR intent kept: owner scoping through the `self` relation, B15; SEC1: expects 404, `ResourceNotFound`, like an absent or reserved entry) | kept: test/user-metadata-controller.test.ts |
| 8 | 165 | UserMetadataController > own metadata — write > adds a new entry | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 9 | 172 | UserMetadataController > own metadata — write > forces ownership — a user_id sent in the payload is ignored | adapt | C2 | users-http/test/ (IDOR intent kept: ownership forced on write, B15) | kept: test/user-metadata-controller.test.ts |
| 10 | 179 | UserMetadataController > own metadata — write > updates an existing entry by key | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 11 | 185 | UserMetadataController > own metadata — write > updates an existing entry by id | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 12 | 201 | UserMetadataController > own metadata — write > updates by id without touching an entry whose key is that number | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 13 | 219 | UserMetadataController > own metadata — write > cannot update an entry of another user by key | adapt | C2 | users-http/test/ (IDOR intent kept: owner scoping through the `self` relation, B15; SEC1: expects 404, `ResourceNotFound`, like an absent or reserved entry) | kept: test/user-metadata-controller.test.ts |
| 14 | 225 | UserMetadataController > own metadata — write > cannot update an entry of another user by id | adapt | C2 | users-http/test/ (IDOR intent kept: owner scoping through the `self` relation, B15; SEC1: expects 404, `ResourceNotFound`, like an absent or reserved entry) | kept: test/user-metadata-controller.test.ts |
| 15 | 233 | UserMetadataController > own metadata — write > deletes an own entry | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 16 | 242 | UserMetadataController > own metadata — write > cannot delete an entry of another user | adapt | C2 | users-http/test/ (IDOR intent kept: owner scoping through the `self` relation, B15; SEC1: expects 404, `ResourceNotFound`, like an absent or reserved entry) | kept: test/user-metadata-controller.test.ts |
| 17 | 252 | UserMetadataController > protected metadata keys > refuses to plant the invite marker through own POST /user/metadata | adapt | C2 | users-http/test/ (A12, SR-02: SEC1 reserved-prefix guard kept on the `@Access` routes) | kept: test/user-metadata-controller.test.ts |
| 18 | 260 | UserMetadataController > protected metadata keys > refuses to rewrite an entry Key to the invite marker through own PATCH | adapt | C2 | users-http/test/ (A12, SR-02: SEC1 reserved-prefix guard kept on the `@Access` routes) | kept: test/user-metadata-controller.test.ts |
| 19 | 269 | UserMetadataController > protected metadata keys > refuses to plant the invite marker through the admin route | adapt | C2 | users-http/test/ (A12, SR-02: SEC1 reserved-prefix guard kept on the `@Access` routes) | kept: test/user-metadata-controller.test.ts |
| 20 | 277 | UserMetadataController > protected metadata keys > still allows an ordinary key through the generic write API | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 21 | 286 | UserMetadataController > admin routes > lists the metadata of any user | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 22 | 292 | UserMetadataController > admin routes > lists the metadata of any user when no pagination is supplied | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 23 | 298 | UserMetadataController > admin routes > returns a single entry of any user by key | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 24 | 304 | UserMetadataController > admin routes > adds metadata to any user | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 25 | 311 | UserMetadataController > admin routes > updates metadata of any user, scoped to that user | adapt | C2 | users-http/test/ (SEC1: the admin PATCH takes the entry id or key as a plain param, no `@FromModel`) | kept: test/user-metadata-controller.test.ts |
| 26 | 320 | UserMetadataController > admin routes > deletes metadata of any user | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |
| 27 | 329 | UserMetadataController > admin routes > does not delete an entry that belongs to a different user than the one addressed | adapt | C2 | users-http/test/ (IDOR intent kept: owner scoping through the `self` relation, B15; SEC1: expects 404, `ResourceNotFound`, like an absent or reserved entry) | kept: test/user-metadata-controller.test.ts |
| 28 | 337 | UserMetadataController > admin routes > leaves the rest of the metadata of the user alone when one entry is removed | adapt | C2 | users-http/test/ | kept: test/user-metadata-controller.test.ts |

## test/users-controller.test.ts

Admin user records, roles, role guard and credential and lifecycle actions; user-record and lifecycle tests adapt in C2, role and guard tests rewrite (C4 or C2), credential tests rewrite (N8b).

| # | Line | Test | Class | Lane | Target | Now |
|---|---|---|---|---|---|---|
| 1 | 175 | Admin user controllers > Users.list > returns all users with the total count header | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 2 | 188 | Admin user controllers > Users.list > never exposes password hashes nor internal ids | adapt | C2 | users-http/test/ (B17: password and internal id are not readable fields) | kept: test/users-controller.test.ts |
| 3 | 198 | Admin user controllers > Users.list > paginates | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 4 | 211 | Admin user controllers > Users.list > honours the page number when no limit is sent | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 5 | 219 | Admin user controllers > Users.list > orders by the requested column | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 6 | 225 | Admin user controllers > Users.list > rejects a sort column that is not whitelisted | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 7 | 229 | Admin user controllers > Users.list > includes the Metadata relation when asked to | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 8 | 237 | Admin user controllers > Users.list > filters by login | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 9 | 244 | Admin user controllers > Users.list > filters by IsActive | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 10 | 251 | Admin user controllers > Users.list > filters by the user:niceName metadata column | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 11 | 258 | Admin user controllers > Users.list > caps the page size, so the endpoint cannot be turned into a table dump | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 12 | 277 | Admin user controllers > Users.list > does not leak credential metadata through the listing either | adapt | C2 | users-http/test/ (SR-01 intent kept: reserved keys hidden, SEC1/A12) | kept: test/users-controller.test.ts |
| 13 | 287 | Admin user controllers > Users.list > reports the filtered count, not the table count, in X-Total-Count | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 14 | 294 | Admin user controllers > Users.list > filters by holding any of several roles | rewrite | C2 → C2 | users-http/test/v3/ (B11: filter by holders through an assignment join; the Role column is gone, H13) | replaced: test/v3/admin-roles.test.ts (filters by holding any of several roles, from the GLOBAL assignments) |
| 15 | 311 | Admin user controllers > Users.list > filters accounts that never logged in | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 16 | 323 | Admin user controllers > Users.list > lists soft-deleted accounts when the request filters on DeletedAt | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 17 | 338 | Admin user controllers > Users.getSingleUser / getByLogin > returns the user without password or internal id | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 18 | 348 | Admin user controllers > Users.getSingleUser / getByLogin > returns metadata of the user when the relation is populated | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 19 | 360 | Admin user controllers > Users.getSingleUser / getByLogin > never returns credential-bearing metadata | adapt | C2 | users-http/test/ (SR-01 intent kept: reserved keys hidden, SEC1/A12) | kept: test/users-controller.test.ts |
| 20 | 379 | Admin user controllers > Users.addUser > creates an inactive user with the requested role | adapt | C2 | users-http/test/ (roles seeded and read back as assignments, H13) | kept: test/users-controller.test.ts |
| 21 | 399 | Admin user controllers > Users.addUser > creates a user holding every role of a list | adapt | C2 | users-http/test/ (roles seeded and read back as assignments, H13) | kept: test/users-controller.test.ts |
| 22 | 406 | Admin user controllers > Users.addUser > still accepts a single role name | adapt | C2 | users-http/test/ (roles seeded and read back as assignments, H13) | kept: test/users-controller.test.ts |
| 23 | 414 | Admin user controllers > Users.addUser > trims and de-duplicates the list | adapt | C2 | users-http/test/ (roles seeded and read back as assignments, H13) | kept: test/users-controller.test.ts |
| 24 | 423 | Admin user controllers > Users.addUser > refuses the whole list when one role is not allowed | rewrite | C2 → C2 | users-http/test/v3/ (B26 escalation guard, B43 batch all-or-nothing; guard message differs) | replaced: test/v3/admin-roles.test.ts (refuses the whole list when one role is refused, and creates nothing) |
| 25 | 434 | Admin user controllers > Users.addUser > hands the account over by issuing a password reset token | rewrite | C2 → C2 | users-http/test/v3/ (A11, A12, SR-09: the hand-over is the invite, C1 task 3, N3 task 5, A11, A32, not a reset token; no secret in users_metadata) | replaced: test/v3/admin-roles.test.ts (hands the account over through an invite sent for the caller) |
| 26 | 447 | Admin user controllers > Users.addUser > creates a user even though no create middleware is configured | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 27 | 458 | Admin user controllers > Users.addUser > creates a user with an explicitly empty create middleware list | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 28 | 469 | Admin user controllers > Users.addUser > runs configured beforeCreate middleware | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 29 | 486 | Admin user controllers > Users.addUser > never returns the generated temporary password nor the hash | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 30 | 494 | Admin user controllers > Users.addUser > stores the password hashed, never in plain text | adapt | C2 | users-http/test/ | kept, rewritten: test/users-controller.test.ts ("stores no password, never one in plain text"; `create()` no longer sets one, C1) |
| 31 | 502 | Admin user controllers > Users.addUser > attaches metadata passed in the request | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 32 | 515 | Admin user controllers > Users.addUser > refuses metadata keys that decide account access | adapt | C2 | users-http/test/ (A12, SR-02: SEC1 reserved-prefix guard kept) | kept: test/users-controller.test.ts |
| 33 | 530 | Admin user controllers > Users.addUser > refuses glob metadata keys | adapt | C2 | users-http/test/ (A12, SR-02: SEC1 reserved-prefix guard kept) | kept: test/users-controller.test.ts |
| 34 | 541 | Admin user controllers > Users.addUser > emits the UserCreated event | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 35 | 548 | Admin user controllers > Users.addUser > rejects a duplicated email with a conflict, not a driver error | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 36 | 552 | Admin user controllers > Users.addUser > rejects a duplicated login with a conflict, not a driver error | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 37 | 563 | Admin user controllers > Users.addUser > names the clashing field in the conflict, in the ajv shape a schema rejection uses | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 38 | 571 | Admin user controllers > Users.addUser > names both fields when the login and the email are each taken | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 39 | 577 | Admin user controllers > Users.addUser > rejects a malformed email | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 40 | 581 | Admin user controllers > Users.addUser > rejects an unknown role | rewrite | C2 → C2 | users-http/test/v3/ (B12, B43: an unknown role is InvalidArgument at the AuthzAdmin write) | replaced: test/v3/admin-roles.test.ts (answers an unknown role with InvalidArgument and creates nothing) |
| 41 | 585 | Admin user controllers > Users.addUser > rejects a role that grants more than the caller holds | rewrite | C2 → C2 | users-http/test/v3/ (B26 escalation guard via AuthzAdmin, B43) | replaced: test/v3/admin-roles.test.ts (answers a role that grants more than the caller holds with Forbidden) |
| 42 | 594 | Admin user controllers > Users.addUser > reports a conflict for a login held by a soft-deleted account | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 43 | 602 | Admin user controllers > Users.updateUser > updates login, email and role | adapt | C2 | users-http/test/ (roles as assignments, H13) | kept: test/users-controller.test.ts |
| 44 | 614 | Admin user controllers > Users.updateUser > replaces the whole role list when one is sent | adapt | C2 | users-http/test/ (roles as assignments, H13) | kept: test/users-controller.test.ts |
| 45 | 624 | Admin user controllers > Users.updateUser > revokes the roles a shorter list leaves out | adapt | C2 | users-http/test/ (roles as assignments, H13) | kept: test/users-controller.test.ts |
| 46 | 633 | Admin user controllers > Users.updateUser > keeps existing values for fields that are not sent | adapt | C2 | users-http/test/ (roles as assignments, H13) | kept: test/users-controller.test.ts |
| 47 | 644 | Admin user controllers > Users.updateUser > rejects a login already taken by another account | adapt | C2 | users-http/test/ (roles as assignments, H13) | kept: test/users-controller.test.ts |
| 48 | 650 | Admin user controllers > Users.updateUser > accepts a no-op update to the account s own login | adapt | C2 | users-http/test/ (roles as assignments, H13) | kept: test/users-controller.test.ts |
| 49 | 657 | Admin user controllers > Users.updateUser > does not touch other users | adapt | C2 | users-http/test/ (roles as assignments, H13) | kept: test/users-controller.test.ts |
| 50 | 665 | Admin user controllers > Users.updateUser > applies the role guard to a role replacement | rewrite | C2 → C2 | users-http/test/v3/ (B26, B43: the system role cannot be handed out, AdminGuard) | replaced: test/v3/admin-roles.test.ts (refuses the non-assignable system role on a replacement) |
| 51 | 673 | Admin user controllers > Users.removeUser / restoreUser > soft deletes the account and drops its sessions | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 52 | 688 | Admin user controllers > Users.removeUser / restoreUser > restores a deleted account without activating it | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 53 | 700 | Admin user controllers > Users.removeUser / restoreUser > refuses to restore an account that is not deleted | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 54 | 704 | Admin user controllers > Users.removeUser / restoreUser > reports a not found for a uuid that does not exist | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 55 | 708 | Admin user controllers > Users.removeUser / restoreUser > refuses to delete the caller s own account | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 56 | 716 | Admin user controllers > Roles > grants a role, keeping the existing ones | rewrite | C2 → C4 | authz-http-admin/test/ (B43 assign and revoke through AuthzAdmin routes, B27 RoleAssigned/RoleRevoked) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 57 | 724 | Admin user controllers > Roles > does not duplicate an already granted role | rewrite | C2 → C4 | authz-http-admin/test/ (B43 assign and revoke through AuthzAdmin routes, B27 RoleAssigned/RoleRevoked) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 58 | 731 | Admin user controllers > Roles > revokes a role | rewrite | C2 → C4 | authz-http-admin/test/ (B43 assign and revoke through AuthzAdmin routes, B27 RoleAssigned/RoleRevoked) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 59 | 742 | Admin user controllers > Roles > rejects an empty role name | rewrite | C2 → C4 | authz-http-admin/test/ (B43 assign and revoke through AuthzAdmin routes, B27 RoleAssigned/RoleRevoked) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 60 | 748 | Admin user controllers > Role guard > refuses a role that is not declared in configuration | rewrite | C2 → C4 | authz-http-admin/test/ (B12, B43: unknown role is InvalidArgument) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 61 | 752 | Admin user controllers > Role guard > refuses to hand out the system role | rewrite | C2 → C4 | authz-http-admin/test/ (B26 guard part: DefaultAdminGuard system role) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 62 | 760 | Admin user controllers > Role guard > refuses to grant a role that holds more than the caller | rewrite | C2 → C4 | authz-http-admin/test/ (B26 escalation via covers, B43) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 63 | 764 | Admin user controllers > Role guard > allows a stronger caller to grant that same role | rewrite | C2 → C4 | authz-http-admin/test/ (B26 escalation via covers, B43) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 64 | 773 | Admin user controllers > Role guard > refuses to revoke the caller s own privileged role | rewrite | C2 → C4 | authz-http-admin/test/ (B26 guard part: self-lockout) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 65 | 779 | Admin user controllers > Role guard > refuses to revoke the last privileged role in the installation | rewrite | C2 → C2 | users-http/test/v3/ (B26 guard covers `AuthzAdmin` commands only; `deactivateUser` is a users-http lifecycle route and 3.0 has no rule for it, see U2: C2 either keeps a last-privileged-holder check on deactivate and the design gets a line for it, or the row becomes drop) | replaced: test/v3/account-guard.test.ts (refuses to take the last privileged account out of service) |
| 66 | 789 | Admin user controllers > Role guard > allows removing an administrator while another one remains | adapt | C2 | users-http/test/ (deactivating one administrator while another remains succeeds; B26 does not cover the lifecycle route, see U2) | kept: test/users-controller.test.ts |
| 67 | 794 | Admin user controllers > Role guard > is switchable: escalation may be allowed | rewrite | C2 → C4 | authz-http-admin/test/ (B26 guard switches under authz.admin.*, not rbac.admin.roleGuard.*) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 68 | 801 | Admin user controllers > Role guard > is switchable: unknown roles may be allowed | rewrite | C2 → C4 | authz-http-admin/test/ (B26 guard switches under authz.admin.*, not rbac.admin.roleGuard.*) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 69 | 816 | Admin user controllers > Role guard > is switchable: the system role may be handed out | rewrite | C2 → C4 | authz-http-admin/test/ (B26 guard switches under authz.admin.*, not rbac.admin.roleGuard.*) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 70 | 825 | Admin user controllers > Role guard > is switchable: self lockout may be allowed | rewrite | C2 → C2 | users-http/test/v3/ (B26 guard covers `AuthzAdmin` commands only; `deactivateUser` is a users-http lifecycle route and 3.0 has no rule for it, see U2: C2 either keeps a last-privileged-holder check on deactivate and the design gets a line for it, or the row becomes drop) | replaced: test/v3/account-guard.test.ts (allows the caller s own account with preventSelfLockout off) |
| 71 | 832 | Admin user controllers > Role guard > reports only the roles the caller may assign | rewrite | C2 → C4 | authz-http-admin/test/ (B26, B43: roles the actor may assign; the assignableRoles route is C4 territory) | deleted: covered by authz-http-admin/test/legacy-roles.test.ts |
| 72 | 842 | Admin user controllers > Security > changes the user password to a new, verifiable one | rewrite | C2 → N8b | authn-http/test/v3/ (A25, SR-10: credential admin route `/authn/admin/users/:uuid/*` with target guard) | legacy-v2: test/legacy-v2/users-controller.test.ts |
| 73 | 862 | Admin user controllers > Security > changes the password of a user whose metadata already exists | drop | C2 | guards a `users_metadata` write that 3.0 no longer makes (A12: the password lives in `users.Password`); A06 resets the account key only on a successful login, so an admin password change clearing backoff has no rule; the admin password change itself is covered by row 842's replacement | deleted (drop) |
| 74 | 875 | Admin user controllers > Security > issues a password reset token without returning it | rewrite | C2 → N8b | authn-http/test/v3/ (A11, A25, SR-09: reset secret in authn_secret, never returned) | legacy-v2: test/legacy-v2/users-controller.test.ts |
| 75 | 884 | Admin user controllers > Security > deactivates an active account | adapt | C2 | users-http/test/ (lifecycle route on `@Access('users:*')`) | kept: test/users-controller.test.ts |
| 76 | 893 | Admin user controllers > Security > refuses to deactivate the caller s own account | adapt | C2 | users-http/test/ (lifecycle route on `@Access('users:*')`) | kept: test/users-controller.test.ts |
| 77 | 899 | Admin user controllers > Security > activates an inactive account | adapt | C2 | users-http/test/ (lifecycle route on `@Access('users:*')`) | kept: test/users-controller.test.ts |
| 78 | 908 | Admin user controllers > Security > bans and unbans an account | adapt | C2 | users-http/test/ (lifecycle ban; the SR-06 session revoke is N2) | kept: test/users-controller.test.ts |
| 79 | 925 | Admin user controllers > Security > refuses to ban the caller s own account | adapt | C2 | users-http/test/ (lifecycle route on `@Access('users:*')`) | kept: test/users-controller.test.ts |
| 80 | 931 | Admin user controllers > Security > clears a login lockout | drop | C2 | A06, H31: no key ever locks and the owner gets in within `maxDelayMs`; design §4.1.1 lists no unlock or throttle reset among the credential admin routes and N8b task 5 adds none; not an SR or IDOR test | deleted (drop) |
| 81 | 947 | Admin user controllers > Security > expires a password, which takes the account out of service | rewrite | C2 → N8b | authn-http/test/v3/ (password expiry moves to authn-local N3 and is not a C2 lifecycle route; A25 target guard) | legacy-v2: test/legacy-v2/users-controller.test.ts |
| 82 | 954 | Admin user controllers > Security > refuses to expire the caller s own password | rewrite | C2 → N8b | authn-http/test/v3/ (password expiry moves to authn-local N3 and is not a C2 lifecycle route; A25 target guard) | legacy-v2: test/legacy-v2/users-controller.test.ts |
| 83 | 958 | Admin user controllers > Security > resets the 2fa secrets of a user | rewrite | C2 → N8b | authn-http/test/v3/ (A10, A12, A25: MFA reset in the authn-totp store, not users_metadata) | legacy-v2: test/legacy-v2/users-controller.test.ts |
| 84 | 974 | Admin user controllers > Security > enables and disables 2fa for a user | rewrite | C2 → N8b | authn-http/test/v3/ (A10: `SR-10 admin MFA reset returns no secret`, §3c; the 3.0 test asserts the opposite of 2.x, which returned the otpauth url) | legacy-v2: test/legacy-v2/users-controller.test.ts |
| 85 | 987 | Admin user controllers > Security > drops every session of the user on forced logout | rewrite | C2 → N8b | authn-http/test/v3/ (A08, A25: revoke all sessions through authn-session) | legacy-v2: test/legacy-v2/users-controller.test.ts |
| 86 | 999 | Admin user controllers > Security > lists sessions by opaque handle, never by session id | rewrite | C2 → N8b | authn-http/test/v3/ (A07, A25: sessions listed and revoked by handle; ids stored hashed) | legacy-v2: test/legacy-v2/users-controller.test.ts |
| 87 | 1017 | Admin user controllers > Security > revokes a single session by handle | rewrite | C2 → N8b | authn-http/test/v3/ (A07, A25: sessions listed and revoked by handle; ids stored hashed) | legacy-v2: test/legacy-v2/users-controller.test.ts |
| 88 | 1034 | Admin user controllers > Security > reports a not found for a handle that is not this user s | rewrite | C2 → N8b | authn-http/test/v3/ (A25, IDOR intent kept: a handle of another user is not found) | legacy-v2: test/legacy-v2/users-controller.test.ts |
| 89 | 1046 | Admin user controllers > Profile > returns the profile of a user identified by login | adapt | C2 | users-http/test/ | kept: test/users-controller.test.ts |
| 90 | 1089 | Admin user controllers > own-permission route gate + model token > readOwn holder passes the route gate on GET /users | rewrite | C2 → C2 | users-http/test/v3/ (B15 owner relation, B23 `@Access` gate replaces `readOwn` and RbacPolicy) | legacy-v2: test/legacy-v2/users-controller.test.ts |
| 91 | 1098 | Admin user controllers > own-permission route gate + model token > list is row-scoped once an @OrmResource-carrying subclass is registered | rewrite | C2 → C2 | users-http/test/v3/ (B20, B15, B21: list scoped by the `@AccessResource` residual, not `OrmPermissionPolicy.scopeRead`) | legacy-v2: test/legacy-v2/users-controller.test.ts |

## test/z-controller-refresh.test.ts

Unit test of `UserController.refresh` with a fake session provider; adapt except the session write.

| # | Line | Test | Class | Lane | Target | Now |
|---|---|---|---|---|---|---|
| 1 | 57 | UserController.refresh > stores the user UUID (not a dehydrated object) back into the session | rewrite | C2 → C2 | users-http/test/v3/ (A07, A23: the session holds identity through authn-session; no `Data.User` uuid write); repeats user-controller-db 125, one replacement covers both | replaced (C2b task 1): test/v3/user-profile.test.ts `keeps resolving the same user on the next request with the same session` |
| 2 | 72 | UserController.refresh > does not touch the session when no valid ssid reaches the handler | drop | C2 | guards the session write of row 57; 3.0 makes no such write (A07, A23: identity lives in authn-session), so there is nothing to guard and the replacement of row 57 covers it | deleted with the file (C2b task 1; GET /user writes nothing to the session) |
| 3 | 85 | UserController.refresh > returns the user with relations and ISO dates, matching every other user response | adapt | C2 | users-http/test/ | replaced (C2b task 1): test/v3/user-profile.test.ts `answers the record with its metadata and ISO dates, reserved metadata left out` |
