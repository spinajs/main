# Test ledger: @spinajs/users

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
| move | 42 |
| adapt | 117 |
| rewrite | 180 |
| drop | 26 |
| **total** | 365 |

`test/cli.test.ts` came later, from master `228090a22` (2.0.549), merged in G1b.

Mixed files: in `actions`, `actions-fundamentals`, `auth` and `user`, C1 splits the file. Kept (move/adapt) rows stay or move as classed; rewrite rows go to `test/legacy-v2/<same file name>`. T1 deletes every `users/test/legacy-v2/` file once the replacements named in the Target column exist, whichever lane writes them (plan §5 gives T lanes the deletion of `legacy-v2`). Drop rows use lane T1 throughout.

Lane codes: C1 users (identity), N1 authn core, N2 authn-session and session providers, N3 authn-local, T1 test port of the 2.x rbac suites.

## test/actions-fundamentals.test.ts

Mixed file: C1 splits it. Kept rows stay or move as classed; rewrite rows go to `test/legacy-v2/actions-fundamentals.test.ts`, which T1 deletes once the replacements named in Target exist.

Imperative user helpers (lookup, metadata, uniqueness, role list, ban, reset regressions). Dominant class: adapt (C1); the reset and password rows go to N3.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 56 | actions fundamentals ( imperative helpers ) > getUser / getUserUnsafe > resolves a user by email with metadata populated | adapt | C1 | users/test/ |
| 2 | 64 | actions fundamentals ( imperative helpers ) > getUser / getUserUnsafe > returns a passed User instance as-is | adapt | C1 | users/test/ |
| 3 | 71 | actions fundamentals ( imperative helpers ) > getUser / getUserUnsafe > rejects for an unknown identifier | adapt | C1 | users/test/ |
| 4 | 75 | actions fundamentals ( imperative helpers ) > getUser / getUserUnsafe > getUserUnsafe resolves any user through the base model | adapt | C1 | users/test/ |
| 5 | 83 | actions fundamentals ( imperative helpers ) > roleList > normalises a single role to a one-element list | adapt | C1 | users/test/ |
| 6 | 87 | actions fundamentals ( imperative helpers ) > roleList > trims, drops blanks and de-duplicates while preserving order | adapt | C1 | users/test/ |
| 7 | 91 | actions fundamentals ( imperative helpers ) > roleList > answers an empty list for nil input | adapt | C1 | users/test/ |
| 8 | 98 | actions fundamentals ( imperative helpers ) > assertNoProtectedMetadata > passes benign keys and empty input | adapt | C1 | users/test/ Reserved-prefix guard kept from SEC1 (A12). |
| 9 | 103 | actions fundamentals ( imperative helpers ) > assertNoProtectedMetadata > refuses protected security keys | adapt | C1 | users/test/ SEC1 prefix list (A12); keys still refused. |
| 10 | 108 | actions fundamentals ( imperative helpers ) > assertNoProtectedMetadata > refuses glob patterns that could rewrite protected entries | adapt | C1 | users/test/ SEC1 checks by prefix; glob refusal must stay (SR-02 intent). |
| 11 | 115 | actions fundamentals ( imperative helpers ) > assertUserUnique > refuses a taken email and names the clashing field | adapt | C1 | users/test/ |
| 12 | 122 | actions fundamentals ( imperative helpers ) > assertUserUnique > lets an account keep its own values via exceptUserId | adapt | C1 | users/test/ |
| 13 | 128 | actions fundamentals ( imperative helpers ) > assertUserUnique > passes for free values | adapt | C1 | users/test/ |
| 14 | 134 | actions fundamentals ( imperative helpers ) > setUserMeta / getUserMeta > writes a single key-value pair and reads it back | adapt | C1 | users/test/ |
| 15 | 144 | actions fundamentals ( imperative helpers ) > setUserMeta / getUserMeta > writes an entry array in one call | adapt | C1 | users/test/ |
| 16 | 160 | actions fundamentals ( imperative helpers ) > setUserMeta / getUserMeta > emits UserMetadataChange carrying the resolved entries, not a function | adapt | C1 | users/test/ |
| 17 | 172 | actions fundamentals ( imperative helpers ) > setUserMeta / getUserMeta > getUserMeta throws MetadataNotFound for a missing key | adapt | C1 | users/test/ |
| 18 | 180 | actions fundamentals ( imperative helpers ) > updateUser > persists partial changes and emits UserChanged | adapt | C1 | users/test/ |
| 19 | 194 | actions fundamentals ( imperative helpers ) > verifyPassword > confirms the stored password | rewrite | C1 → N3 | `authn-local/test/ported/` (A03) `verifyPassword` leaves `users`; hasher verify on the 2.x fixture hash. Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 20 | 200 | actions fundamentals ( imperative helpers ) > verifyPassword > refuses a wrong password | rewrite | C1 → N3 | `authn-local/test/ported/` (A03) Same as above. Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 21 | 208 | actions fundamentals ( imperative helpers ) > getUsersByRole > finds users carrying the role | adapt | C1 | users/test/ Role seeded as an assignment, lookup via `AssignmentStore.holders` (C1 task 5, H13). |
| 22 | 227 | actions fundamentals ( imperative helpers ) > audit finding regressions > R1: ban() accepts a user whose previous ban has expired | adapt | C1 | users/test/ Ban lifecycle stays in `users`. |
| 23 | 245 | actions fundamentals ( imperative helpers ) > audit finding regressions > R1: confirmPasswordReset() accepts a user whose ban has expired | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A12) Reset token is a `SecretStore` entry, not metadata; ban checked at redeem (A02 answer). |
| 24 | 262 | actions fundamentals ( imperative helpers ) > audit finding regressions > R3: TokenInvalid does not leak the stored reset token | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A02) Opaque redeem failure; payload must not carry the stored secret (A11, A21). |
| 25 | 276 | actions fundamentals ( imperative helpers ) > audit finding regressions > R6: UserCreated carries the account fields it declares | adapt | C1 | users/test/ Role seeded as an assignment (H13). |

## test/actions.test.ts

Mixed file: C1 splits it. Kept rows stay or move as classed; rewrite rows go to `test/legacy-v2/actions.test.ts`, which T1 deletes once the replacements named in Target exist.

User lifecycle actions (create, activate, ban, delete), the login, reset and invite flows, lockout, session revocation and role grants. Mixed: adapt for lifecycle and create (C1), rewrite for login, reset, lockout and role grants (N3, N1, T1).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 59 | User model tests > Should activate user | adapt | C1 | users/test/ Lifecycle action; event order unchanged. |
| 2 | 76 | User model tests > Should not send event when user is already activated | adapt | C1 | users/test/ |
| 3 | 80 | User model tests > activate resolves with the user, not the notification email result | adapt | C1 | users/test/ |
| 4 | 87 | User model tests > deactivate resolves with the user, not the notification email result | adapt | C1 | users/test/ |
| 5 | 94 | User model tests > ban resolves with the user, not the notification email result | adapt | C1 | users/test/ |
| 6 | 101 | User model tests > expirePassword emits UserPasswordExpired carrying the user uuid | adapt | C1 | users/test/ Stays in `users`: design §4.1 keeps `expire` among the users lifecycle actions, and the test imports `expirePassword` and `UserPasswordExpired` from `users`; plan §1 rule 10 bars `authn*` from importing `users`. N3 task 6 moves only the expiry policy (`authn.local.expiration`) and its trigger. Plan and design conflict here; the ledger follows the design. |
| 7 | 111 | User model tests > Should deactivate user | adapt | C1 | users/test/ |
| 8 | 126 | User model tests > Should create user | adapt | C1 | users/test/ `user.Role` assertion becomes an assignment read (H13, B12 default roles). Count only user events, or stub `AuthzAdmin`: `create` now publishes `RoleAssigned` (B27), so `eStub.callCount` can change. |
| 9 | 153 | User model tests > Should persist the registration date of a created user | adapt | C1 | users/test/ |
| 10 | 165 | User model tests > Should create user with metadata | adapt | C1 | users/test/ `user.Role` assertion becomes an assignment read (H13). Same event-count note as row 8. |
| 11 | 196 | User model tests > Should create user with beforeCreate and afterCreate middleware | adapt | C1 | users/test/ `users.actions.create.*` middleware config unchanged. |
| 12 | 238 | User model tests > Should create user when create middleware lists are empty | adapt | C1 | users/test/ |
| 13 | 255 | User model tests > Should create user when create middleware config is not declared at all | adapt | C1 | users/test/ |
| 14 | 270 | User model tests > Should ignore malformed (non array) create middleware config | adapt | C1 | users/test/ |
| 15 | 283 | User model tests > Shouldn create user with already existing email | adapt | C1 | users/test/ |
| 16 | 287 | User model tests > Shouldn create user with already existing login | adapt | C1 | users/test/ |
| 17 | 296 | User model tests > Should name the clashing field when refusing a duplicate | adapt | C1 | users/test/ |
| 18 | 314 | User model tests > Should refuse a login taken by a soft-deleted account | adapt | C1 | users/test/ |
| 19 | 328 | User model tests > Should refuse a duplicate before running create middleware | adapt | C1 | users/test/ |
| 20 | 345 | User model tests > Should generate a password and issue a reset link when none is given | rewrite | C1 → T1 | `users/test/v3/` (A11, A32) C1 task 3: `create` invites through `PasswordService.invite`. The test asserts what `create()` does, so it stays in `users` (plan §1 rule 10 bars authn-local from calling `create`). No token in `users_metadata`. |
| 21 | 365 | User model tests > Should not issue a reset link when the caller supplied the password | rewrite | C1 → T1 | `users/test/v3/` (A11, A12) C1 task 3: no invite for a caller-supplied password; the assertion moves from metadata to `SecretStore`. |
| 22 | 379 | User model tests > Should still create the account when the reset link cannot be issued | adapt | C1 | users/test/ (A11) The account survives a failed invite mail; the assertion holds unchanged. |
| 23 | 399 | User model tests > Should mail a new account exactly one message, carrying the reset link | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, SR-09) `SR-09 queued mail holds no secret`: secret rendered at send time, so the 2.x assertion `model.Token` equals stored token changes. |
| 24 | 412 | User model tests > Should issue the invite link with the invite lifetime, not the reset one | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A32) Invite lifetime kept; read from `SecretStore` expiry, purpose `invite`. |
| 25 | 428 | User model tests > Should mark the creation mail as an invite | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A32) `IsInvite` mail flag kept; mail rendered at send time (SR-09). |
| 26 | 437 | User model tests > Should mark a created account as awaiting its invite | adapt | C1 | users/test/ `user:invite:pending` stays in metadata and in `IdentityStore` status (A32; design §18.2). |
| 27 | 446 | User model tests > Should not mark an account created with a caller-supplied password | adapt | C1 | users/test/ Same marker rule as above. |
| 28 | 461 | User model tests > Should refuse metadata keys that decide account access | adapt | C1 | users/test/ SEC1 reserved prefixes (A12, SR-01/SR-02 guard); message text may change. |
| 29 | 478 | User model tests > Should refuse glob metadata keys | adapt | C1 | users/test/ SEC1 guard, glob keys refused. |
| 30 | 489 | User model tests > Should refuse the invite marker as caller-supplied metadata | adapt | C1 | users/test/ `user:invite:` is a reserved prefix (SEC1, A12). |
| 31 | 502 | User model tests > Should honour an explicit id | adapt | C1 | users/test/ |
| 32 | 510 | User model tests > Should delete user | adapt | C1 | users/test/ |
| 33 | 529 | User model tests > Should ban user | adapt | C1 | users/test/ |
| 34 | 551 | User model tests > Should unban user | adapt | C1 | users/test/ |
| 35 | 576 | User model tests > Should not unban a user that is not banned | adapt | C1 | users/test/ |
| 36 | 587 | User model tests > Should carry configured attachments into the queued mail | adapt | C1 | users/test/ |
| 37 | 600 | User model tests > Should queue a mail without an attachments field when the template declares none | adapt | C1 | users/test/ |
| 38 | 611 | User model tests > Should treat a ban as expired once its duration elapses | adapt | C1 | users/test/ |
| 39 | 627 | User model tests > Should change password | rewrite | C1 → N3 | `authn-local/test/ported/` (A03, A30) `PasswordService.change`: fresh auth, other sessions revoked, current rotated; hash is argon2id (A03). |
| 40 | 649 | User model tests > Should reject a password that does not meet requirements | rewrite | C1 → N3 | `authn-local/test/ported/` (A04) Policy 8-128, no trimming; error type must stay `InvalidArgument` (HTTP 400). |
| 41 | 660 | User model tests > Should grant role | rewrite | C1 → T1 | `users/test/v3/` (B11, B12, B27, B43): `grant` becomes `AuthzAdmin.assign`; reads assignments, not `User.Role`. |
| 42 | 677 | User model tests > Should revoke role | rewrite | C1 → T1 | `users/test/v3/` (B11, B27, B43): `revoke` becomes `AuthzAdmin.revoke`. |
| 43 | 689 | User model tests > Should update user | adapt | C1 | users/test/ |
| 44 | 699 | User model tests > Should authenticate user | rewrite | C1 → N3 | `authn-local/test/ported/` (A01, A02, A21) `login()` becomes `AuthnService.authenticate`; `UserLogged`/`UserLoginFailed` come from `QueueAuthnEventSink` (C1 task 10); one failure shape (A02). Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 45 | 709 | User model tests > Should not auth with invalid password | rewrite | C1 → N3 | `authn-local/test/ported/` (A01, A02, A21) `login()` becomes `AuthnService.authenticate`; `UserLogged`/`UserLoginFailed` come from `QueueAuthnEventSink` (C1 task 10); one failure shape (A02). Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 46 | 718 | User model tests > Should not auth with invalid login | rewrite | C1 → N3 | `authn-local/test/ported/` (A01, A02, A21) `login()` becomes `AuthnService.authenticate`; `UserLogged`/`UserLoginFailed` come from `QueueAuthnEventSink` (C1 task 10); one failure shape (A02). Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 47 | 722 | User model tests > Should reject auth with banned user | rewrite | C1 → N3 | `authn-local/test/ported/` (A01, A02, A21) `login()` becomes `AuthnService.authenticate`; `UserLogged`/`UserLoginFailed` come from `QueueAuthnEventSink` (C1 task 10); one failure shape (A02). Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 48 | 731 | User model tests > Should reject auth with not active user | rewrite | C1 → N3 | `authn-local/test/ported/` (A01, A02, A21) `login()` becomes `AuthnService.authenticate`; `UserLogged`/`UserLoginFailed` come from `QueueAuthnEventSink` (C1 task 10); one failure shape (A02). Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 49 | 740 | User model tests > Password change request | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A12) Reset request stores a `SecretStore` entry, not metadata. |
| 50 | 761 | User model tests > issuePasswordResetToken stores the token without sending a mail | rewrite | C1 → N3 | `authn-local/test/ported/` (A11) `issuePasswordResetToken` has no counterpart name; `requestReset` without mail, hashed secret. |
| 51 | 774 | User model tests > issuePasswordResetToken honours an explicit wait time | rewrite | C1 → N3 | `authn-local/test/ported/` (A11) Explicit lifetime on the secret. |
| 52 | 790 | User model tests > Password change request mails the token | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, SR-09) `SR-09 queued mail holds no secret`: mail renders the secret at send time. |
| 53 | 810 | User model tests > Password change request leaves ResetUrl empty when none is configured | rewrite | C1 → N3 | `authn-local/test/ported/` (A11) `authn.local.reset.url` handling. |
| 54 | 819 | User model tests > Password change request builds the reset link from the configured page | rewrite | C1 → N3 | `authn-local/test/ported/` (A11) Reset link built from `authn.local.reset.url`. |
| 55 | 844 | User model tests > Password change after request | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A30) Redeem sets the new password and revokes sessions (A11). |
| 56 | 858 | User model tests > Password change after request with wrong token | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A02) Opaque redeem failure. |
| 57 | 866 | User model tests > Password change after request with expired token | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A02) Expiry on the `SecretStore` entry. |
| 58 | 884 | User model tests > Should confirm a matching password | rewrite | C1 → N3 | `authn-local/test/ported/` (A13) `passwordMatch` is replaced by inline fresh auth. Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 59 | 890 | User model tests > Should not confirm a wrong password | rewrite | C1 → N3 | `authn-local/test/ported/` (A13) Same as above; failed re-auth counts into `reauth` throttle. Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 60 | 899 | User model tests > password reset token > is single use — a redeemed token cannot be redeemed again | rewrite | C1 → N3 | `authn-local/test/ported/` (A11) Single use; `SR-17 reset token reuse` intent (SR-17 is Low, covered by A11). |
| 61 | 915 | User model tests > password reset token > is erased from the user metadata once redeemed | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A12, A32) Secret leaves no trace; no `user:pwd_reset:*` key remains (SR-09). |
| 62 | 929 | User model tests > password reset token > is refused for a banned account | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A02) Status checked at redeem; ban outranks reset. |
| 63 | 941 | User model tests > password reset token > is refused for a deactivated account | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A02) Deactivated account refused. |
| 64 | 956 | User model tests > password reset token > lets a newly invited account redeem its link and activates it | rewrite | C1 → N3 | `authn-local/test/ported/` (A32) Invite redeem activates the identity; purpose `invite` while a pending invite exists. |
| 65 | 972 | User model tests > password reset token > emits UserActivated when an invite is redeemed | rewrite | C1 → N3 | `authn-local/test/ported/` (A32) `UserActivated` emitted on invite redeem. |
| 66 | 989 | User model tests > password reset token > still refuses an inactive account that was never invited | rewrite | C1 → N3 | `authn-local/test/ported/` (A32) Inactive account without a pending invite stays refused. |
| 67 | 1003 | User model tests > password reset token > refuses an invite whose link has expired | rewrite | C1 → N3 | `authn-local/test/ported/` (A11, A32) Expired invite refused. |
| 68 | 1018 | User model tests > password reset token > refuses an invited account that was banned before redeeming | rewrite | C1 → N3 | `authn-local/test/ported/` (A32, A02) Ban outranks invite. |
| 69 | 1030 | User model tests > password reset token > refuses an invited account that was soft-deleted before redeeming | rewrite | C1 → N3 | `authn-local/test/ported/` (A32, A02) Soft delete outranks invite. |
| 70 | 1048 | User model tests > password reset token > refuses an invited account that was deactivated before redeeming | rewrite | C1 → N3 | `authn-local/test/ported/` (A32) `deactivate` withdraws a pending invite. |
| 71 | 1064 | User model tests > password reset token > an admin activation clears the invite marker so a later ordinary reset does not re-activate | rewrite | C1 → T1, N3 | Split. `users/test/v3/` (A32, C1 task 3): `activate` clears the invite marker, which is users identity state. `authn-local/test/ported/` (A32, N3): a later ordinary reset does not re-activate. |
| 72 | 1087 | User model tests > password reset token > treats the invite marker as pending only when it is stored as boolean true | rewrite | C1 → N3 | `authn-local/test/ported/` (A32) Marker counts only when strictly boolean `true`; read through `IdentityStore` status. |
| 73 | 1109 | User model tests > login throttling > counts consecutive failures | rewrite | C1 → N1 | `authn/test/ported/` (A05, A06, H31): count before verify, no `user:login:*` metadata. |
| 74 | 1117 | User model tests > login throttling > locks the account after the configured number of failures and refuses the CORRECT password while locked | rewrite | C1 → N1 | `authn/test/ported/` (A05, A06, H31; `SR-05 attacker cannot lock the owner out`): 3.0 never locks, so a correct password while "locked" is accepted after the backoff slot; expectation changes. |
| 75 | 1133 | User model tests > login throttling > clears the counter and the lock on a successful login | rewrite | C1 → N1 | `authn/test/ported/` (A06, H31): success resets the account key and subtracts its `account-ip` count; no metadata counter. Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 76 | 1146 | User model tests > login throttling > lets an expired lock through | rewrite | C1 → N1 | `authn/test/ported/` (A06, H31): lock replaced by `resetAfterSeconds` decay (FakeClock). Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 77 | 1168 | User model tests > session revocation > destroys the sessions of a user whose password changed | rewrite | C1 → N3 | `authn-local/test/ported/` (A30, A08) The 2.x assertion holds: the test session is not the caller's current session, so A30 still revokes it. Add the A30 case where the current session is kept and rotated; a reset still revokes all. |
| 78 | 1178 | User model tests > session revocation > destroys the sessions of a banned user | adapt | C1 | users/test/ Session revoked on ban through `SessionIssuer.revokeAll` (A08); session set up via the new issuer. |
| 79 | 1190 | User model tests > session revocation > destroys the sessions of a deactivated user | adapt | C1 | users/test/ Same as above for `deactivate` (A08). |
| 80 | 1206 | User model tests > Should refuse a supplied password that does not meet requirements | adapt | C1 | users/test/ Create path calls the `authn-local` policy (A04); assertion unchanged. |
| 81 | 1214 | User model tests > Should accept a supplied password that meets requirements | adapt | C1 | users/test/ Same as above. |
| 82 | 1222 | User model tests > Should trim and de-duplicate the role list | rewrite | C1 → T1 | `users/test/v3/` (B12, B43): `create(user, roles?)` assigns through `AuthzAdmin` as `SYSTEM`; trim and de-duplicate move to the assign path. |
| 83 | 1235 | User model tests > Should refuse a role list that names no role | rewrite | C1 → T1 | `users/test/v3/` (B12, B43): roles are optional; `create` falls back to `authz.rbac.defaultRoles` (C1 task 3), so the "at least one role" refusal goes away. |
| 84 | 1246 | User model tests > Should refuse a role that is not configured in grants | rewrite | C1 → T1 | `users/test/v3/` (B12, B43): unknown role on write is `InvalidArgument` from `AuthzAdmin`; message no longer names `rbac.grants`. |
| 85 | 1254 | User model tests > Should refuse granting a role that is not configured in grants | rewrite | C1 → T1 | `users/test/v3/` (B12, B43): `AuthzAdmin.assign` refuses an unknown role. |
| 86 | 1264 | User model tests > Should accept an undeclared role when rbac.requireKnownRole is false | drop | T1 | `rbac.requireKnownRole` is gone with the `rbac.*` keys; B12 always refuses an unknown role on write. |
| 87 | 1284 | User model tests > Should refuse an unknown role rather than throw when rbac.roles holds a malformed entry | drop | T1 | 2.x-only: tolerates a malformed `rbac.roles` entry; 3.0 validates `authz.rbac.roles` at boot (AJV, B05/B12). |

## test/active-role.test.ts

ActiveRole middleware: role switching and the owner filter. All rewrite (C1 → T1). Plan §5 names B24/D14; the target is `authz-orm/test/ported/` rather than `authz-rbac` because these tests compile ORM queries.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 78 | Rbac ActiveRole middleware > ActiveRole=admin lets read:any through with no owner filter | rewrite | C1 → T1 | authz-orm/test/ported/; B24, B11, B20 (TRUE gives no WHERE) |
| 2 | 97 | Rbac ActiveRole middleware > ActiveRole=normal forces read:own owner filter even though user has admin role too | rewrite | C1 → T1 | authz-orm/test/ported/; B24, B07, D14, B15, B20 (role switch is now ceiling.roles) |
| 3 | 121 | Rbac ActiveRole middleware > ActiveRole pointing to a role without any permission throws Forbidden | rewrite | C1 → T1 | authz-orm/test/ported/; B24, B07, D14, B20 (FALSE gives AccessDenied 403, was Forbidden) |
| 4 | 140 | Rbac ActiveRole middleware > Without ActiveRole the full role list is used (admin role wins) | rewrite | C1 → T1 | authz-orm/test/ported/; B24, B11, B20 |

## test/auth.test.ts

Mixed file: C1 splits it. Kept rows stay or move as classed; rewrite rows go to `test/legacy-v2/auth.test.ts`, which T1 deletes once the replacements named in Target exist.

`SimpleDbAuthProvider` existence, status and authenticate checks. Mixed: status checks adapt to `IdentityStore` (C1), authenticate rewrites to `LocalPasswordStrategy` (N3).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 42 | Authorization provider tests > Should exists | adapt | C1 | users/test/ `AuthProvider.exists` becomes `IdentityStore` lookup (C1 task 10). |
| 2 | 61 | Authorization provider tests > Should check for active user | adapt | C1 | users/test/ `isActive` becomes `IdentityStore` status. |
| 3 | 83 | Authorization provider tests > Should check for deleted user | adapt | C1 | users/test/ `isDeleted` becomes `IdentityStore` status. |
| 4 | 89 | Authorization provider tests > Should check for banned user | adapt | C1 | users/test/ `isBanned` becomes `IdentityStore` status (ban duration included). |
| 5 | 96 | Authorization provider tests > Should return invalid credentials | drop | T1 | Empty body: every assertion is commented out; covered by A02 in `authn-testing`. |
| 6 | 114 | Authorization provider tests > Should authenticate | rewrite | C1 → N3 | `authn-local/test/ported/` (A01, A02) `SimpleDbAuthProvider.authenticate` becomes `LocalPasswordStrategy`. Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 7 | 120 | Authorization provider tests > should auth fail on banned user | rewrite | C1 → N3 | `authn-local/test/ported/` (A02) Banned: same opaque failure as every other login failure. Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 8 | 125 | Authorization provider tests > should auth fail on user not active | rewrite | C1 → N3 | `authn-local/test/ported/` (A02) Inactive account: A02 answer. Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |
| 9 | 130 | Authorization provider tests > Should auth fail on user deleted | rewrite | C1 → N3 | `authn-local/test/ported/` (A02) Deleted account: A02 answer. Login fixture needs a password of 8+ characters (A04); `bbbb` fails. |

## test/cli.test.ts

CLI commands that must boot the Orm themselves (`RbacCliCommand`). Both adapt: the password command moves to N3 as `authn:password` (N3 task 7), the find command stays with C1.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 51 | rbac cli commands > rbac:user-change-password brings the Orm up and changes the password | adapt | C1 → N3 | `authn-local/test/ported/` (A03) Command becomes `authn:password <login>`; keep the Orm-boot assertion. `authn-local` may not import `RbacCliCommand` from `users` (rule 10), so it needs its own base. |
| 2 | 61 | rbac cli commands > rbac:user-find brings the Orm up and reports the user | adapt | C1 | users/test/ |

## test/clone-rbac.test.ts

Row constraints surviving query cloning and counting. All rewrite (C1 → T1).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 110 | rbac constraints survive query cloning > a readOwn caller gets a count that matches the rows it is allowed to see | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B21 (cloned builders get the residual) |
| 2 | 120 | rbac constraints survive query cloning > a readAny caller still counts everything | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B21 (cloned builders get the residual) |
| 3 | 130 | rbac constraints survive query cloning > the clone is constrained even when it is compiled before the original | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B21 (cloned builders get the residual) |
| 4 | 149 | rbac constraints survive query cloning > a clone of a clone stays constrained | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B21 (cloned builders get the residual) |
| 5 | 158 | rbac constraints survive query cloning > a caller-supplied filter narrows both the rows and the count | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B21 (cloned builders get the residual) |

## test/collect-permissions.test.ts

`_collectPermissions` grant helper, a 2.x internal. All drop (T1; plan §5 names it).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 21 | _collectPermissions > returns the permissions of a role with no inheritance | drop | T1 | _collectPermissions is a 2.x internal; role permission union is B11/B12 in authz-rbac |
| 2 | 27 | _collectPermissions > includes everything reached through $extend | drop | T1 | 2.x internal; $extend transitivity is B12 |
| 3 | 34 | _collectPermissions > unions the permissions of several roles | drop | T1 | 2.x internal; union is B11 |
| 4 | 41 | _collectPermissions > answers with an empty set for no roles | drop | T1 | 2.x internal |
| 5 | 45 | _collectPermissions > ignores a role that is not in the grants map | drop | T1 | 2.x internal; unknown roles are B12 |

## test/conformance/session-provider-conformance.ts

`session-conformance.test.ts` (no `it` rows of its own) moves with the suite.

Shared `SessionProvider` conformance suite, imported by `session-conformance.test.ts` and the `session-provider-*` packages. Dominant class: move to `authn-session` (N2 owns sessions and its providers).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 55 | SessionProvider conformance > save / restore round-trip > round-trips SessionId, UserId and Data value types (string, number, boolean, DateTime) | rewrite | N2 → N2 | `authn-session/test/conformance/` (N2 tasks 6-7): shared suite imported by `session-provider-db`, `-redis`, `-dynamodb` (and the memory store); the assertion `restored!.UserId` equals `42` becomes `restored!.Subject` deep-equals the saved `IdentityRef` (G1 contract `ISession.Subject: IdentityRef`, A08); other assertions unchanged. Import path changes from `@spinajs/users` to `@spinajs/authn-session`. Stores key rows by the SessionId they get (hashing lives in `SessionIssuer`). |
| 2 | 79 | SessionProvider conformance > save / restore round-trip > restore returns null for a missing session | move | N2 | `authn-session/test/conformance/` (N2 tasks 6-7): shared suite imported by `session-provider-db`, `-redis`, `-dynamodb` (and the memory store); import path changes from `@spinajs/users` to `@spinajs/authn-session`; `makeSession` builds `Subject: { type: 'user', id }` and `State: 'active'` instead of `UserId`. Stores key rows by the SessionId they get (hashing lives in `SessionIssuer`), so the assertions stay. |
| 3 | 87 | SessionProvider conformance > save / restore round-trip > restore returns null for an expired session | move | N2 | `authn-session/test/conformance/` (N2 tasks 6-7): shared suite imported by `session-provider-db`, `-redis`, `-dynamodb` (and the memory store); import path changes from `@spinajs/users` to `@spinajs/authn-session`; `makeSession` builds `Subject: { type: 'user', id }` and `State: 'active'` instead of `UserId`. Stores key rows by the SessionId they get (hashing lives in `SessionIssuer`), so the assertions stay. |
| 4 | 98 | SessionProvider conformance > save / restore round-trip > save persists Expiration verbatim — does not recompute an already-set expiry (B3) | move | N2 | `authn-session/test/conformance/` (N2 tasks 6-7): shared suite imported by `session-provider-db`, `-redis`, `-dynamodb` (and the memory store); import path changes from `@spinajs/users` to `@spinajs/authn-session`; `makeSession` builds `Subject: { type: 'user', id }` and `State: 'active'` instead of `UserId`. Stores key rows by the SessionId they get (hashing lives in `SessionIssuer`), so the assertions stay. |
| 5 | 116 | SessionProvider conformance > delete / deleteByUser / listByUser / truncate > delete removes a single session | move | N2 | `authn-session/test/conformance/` (N2 tasks 6-7): shared suite imported by `session-provider-db`, `-redis`, `-dynamodb` (and the memory store); import path changes from `@spinajs/users` to `@spinajs/authn-session`; `makeSession` builds `Subject: { type: 'user', id }` and `State: 'active'` instead of `UserId`. Stores key rows by the SessionId they get (hashing lives in `SessionIssuer`), so the assertions stay. |
| 6 | 127 | SessionProvider conformance > delete / deleteByUser / listByUser / truncate > deleteByUser removes all sessions for a user, keyed on numeric UserId | adapt | N2 | `authn-session/test/conformance/` (N2 tasks 6-7): shared suite imported by `session-provider-db`, `-redis`, `-dynamodb` (and the memory store); import path changes from `@spinajs/users` to `@spinajs/authn-session`; `deleteByUser(1)` becomes `deleteBySubject(ref)` and `makeSession` takes `Subject`/`State` instead of `UserId`; expected outcomes unchanged (the title's "numeric UserId" no longer describes the key). Stores key rows by the SessionId they get (hashing lives in `SessionIssuer`). |
| 7 | 145 | SessionProvider conformance > delete / deleteByUser / listByUser / truncate > listByUser returns only that user's live sessions and excludes expired ones | adapt | N2 | `authn-session/test/conformance/` (N2 tasks 6-7): shared suite imported by `session-provider-db`, `-redis`, `-dynamodb` (and the memory store); import path changes from `@spinajs/users` to `@spinajs/authn-session`; `listByUser(...)` becomes `listBySubject(ref)` and `makeSession` takes `Subject`/`State` instead of `UserId`; expected outcomes unchanged. Stores key rows by the SessionId they get (hashing lives in `SessionIssuer`). |
| 8 | 164 | SessionProvider conformance > delete / deleteByUser / listByUser / truncate > truncate clears all sessions | adapt | N2 | `authn-session/test/conformance/` (N2 tasks 6-7): shared suite imported by `session-provider-db`, `-redis`, `-dynamodb` (and the memory store); import path changes from `@spinajs/users` to `@spinajs/authn-session`; `listByUser(...)` becomes `listBySubject(ref)` and `makeSession` takes `Subject`/`State` instead of `UserId`; expected outcomes unchanged. Stores key rows by the SessionId they get (hashing lives in `SessionIssuer`). |
| 9 | 179 | SessionProvider conformance > touch — expiration renewal per strategy > sliding: extends expiration and returns true | move | N2 | `authn-session/test/conformance/` (N2 tasks 6-7): shared suite imported by `session-provider-db`, `-redis`, `-dynamodb` (and the memory store); import path changes from `@spinajs/users` to `@spinajs/authn-session`; `makeSession` builds `Subject: { type: 'user', id }` and `State: 'active'` instead of `UserId`. Stores key rows by the SessionId they get (hashing lives in `SessionIssuer`), so the assertions stay. |
| 10 | 195 | SessionProvider conformance > touch — expiration renewal per strategy > absolute: no-ops, does not write, returns false | move | N2 | `authn-session/test/conformance/` (N2 tasks 6-7): shared suite imported by `session-provider-db`, `-redis`, `-dynamodb` (and the memory store); import path changes from `@spinajs/users` to `@spinajs/authn-session`; `makeSession` builds `Subject: { type: 'user', id }` and `State: 'active'` instead of `UserId`. Stores key rows by the SessionId they get (hashing lives in `SessionIssuer`), so the assertions stay. |
| 11 | 210 | SessionProvider conformance > touch — expiration renewal per strategy > capped: clamps the renewed expiration to Creation + maxLifetime | move | N2 | `authn-session/test/conformance/` (N2 tasks 6-7): shared suite imported by `session-provider-db`, `-redis`, `-dynamodb` (and the memory store); import path changes from `@spinajs/users` to `@spinajs/authn-session`; `makeSession` builds `Subject: { type: 'user', id }` and `State: 'active'` instead of `UserId`. Stores key rows by the SessionId they get (hashing lives in `SessionIssuer`), so the assertions stay. |

## test/create-ownership-idor.test.ts

Insert-time ownership stamping, a 2.x IDOR regression. All rewrite (C1 → T1); none dropped, they map to the T1 IDOR suite.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 71 | Ownership enforcement on inserts (IDOR regression) > createOwn forces the owner column to the acting user | rewrite | C1 → T1 | authz-orm/test/ported/; SR IDOR suite; B20, B15 (insert stamps the @Owner column) |
| 2 | 85 | Ownership enforcement on inserts (IDOR regression) > createOwn overwrites a forged owner id rather than trusting the payload | rewrite | C1 → T1 | authz-orm/test/ported/; SR IDOR suite; B20, B15 (forged owner overwritten) |
| 3 | 102 | Ownership enforcement on inserts (IDOR regression) > createAny leaves the payload alone | rewrite | C1 → T1 | authz-orm/test/ported/; SR IDOR suite; B20 (TRUE passes the payload) |
| 4 | 116 | Ownership enforcement on inserts (IDOR regression) > no create grant is refused | rewrite | C1 → T1 | authz-orm/test/ported/; SR IDOR suite; B20, B01 (no permit gives 403) |

## test/impersonation.test.ts

The 2.x `canImpersonate` rule. All rewrite (C1 → T1); B26 and the `AuthzImpersonationGuard` of C3 replace it.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 35 | canImpersonate > denies when target has a protected role | rewrite | C1 → T1 | users/test/v3/; B26 (protected roles refused, A20); reason code may be renamed |
| 2 | 48 | canImpersonate > denies user → admin (privilege escalation) | rewrite | C1 → T1 | users/test/v3/; B26 (target set not a strict subset) |
| 3 | 60 | canImpersonate > denies admin → admin (equal privileges count as escalation) | rewrite | C1 → T1 | users/test/v3/; B26 (equal sets refused) |
| 4 | 72 | canImpersonate > denies moderator → admin (target has grants moderator lacks) | rewrite | C1 → T1 | users/test/v3/; B26 |
| 5 | 84 | canImpersonate > allows admin → user | rewrite | C1 → T1 | users/test/v3/; B26 (strict subset allowed) |
| 6 | 95 | canImpersonate > allows admin → guest | rewrite | C1 → T1 | users/test/v3/; B26, C3 (`AuthzImpersonationGuard`); with the same fixture admin's set lacks guest's `public:read`, so 3.0 still refuses: keep "refused" and rename the test, whose title says "allows" |
| 7 | 110 | canImpersonate > honors $extend when comparing grants | rewrite | C1 → T1 | users/test/v3/; B12, B26 (extends inherited transitively) |
| 8 | 131 | canImpersonate > treats target with unknown role as having no grants (still allowed by superset check) | rewrite | C1 → T1 | users/test/v3/; B12, B26 (unknown stored role ignored with a warning, empty set is a strict subset) |
| 9 | 143 | canImpersonate > does not flag protected role when protectedRoles is empty | rewrite | C1 → T1 | users/test/v3/; B26 |

## test/m2m-rbac.test.ts

Row scope on a many-to-many target model. All rewrite (C1 → T1).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 120 | rbac on a hasManyToMany target model > applies the hook to the relation, narrowing it to the rows the rule allows | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B21 |
| 2 | 132 | rbac on a hasManyToMany target model > invokes the hook once, not once per builder the relation is made of | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B21 (junction builders get the residual once) |
| 3 | 141 | rbac on a hasManyToMany target model > leaves the relation untouched for an :any grant | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B15 (TRUE leaves the relation untouched) |
| 4 | 156 | rbac on a hasManyToMany target model > keeps a Lazy-deferred, table-guarded hook working | rewrite | C1 → T1 | authz-orm/test/ported/; B20 (IO-needing builder is marked and compiled in beforeQueryExecution) |
| 5 | 167 | rbac on a hasManyToMany target model > still constrains the target when it is queried directly | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B21 |

## test/orm-permission-policy.test.ts

`OrmPermissionPolicy` where-path: operation routing, fallbacks, inserts, named scopes. All rewrite (C1 → T1); `@OrmScope` policies replace it.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 131 | OrmPermissionPolicy where-path > operation routing > select uses scopeRead | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B15 (@OrmScope policy per operation) |
| 2 | 137 | OrmPermissionPolicy where-path > operation routing > update uses scopeUpdate | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B15 |
| 3 | 143 | OrmPermissionPolicy where-path > operation routing > delete uses scopeDelete | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B15 |
| 4 | 151 | OrmPermissionPolicy where-path > operation routing > a policy with only scope() serves read, update and delete | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B15 (OrmScopePolicy (query, principal, op)) |
| 5 | 159 | OrmPermissionPolicy where-path > operation routing > a subclass model declaring the same resource resolves the shared policy | rewrite | C1 → T1 | authz-orm/test/ported/; B21, B20 (shared type, several models) |
| 6 | 167 | OrmPermissionPolicy where-path > fallbacks > OwnerField model with no policy filters by owner column | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B20 (@Owner relation resolver) |
| 7 | 180 | OrmPermissionPolicy where-path > fallbacks > model with no policy and no OwnerField throws OrmException | rewrite | C1 → T1 | authz-orm/test/ported/; B02, B15 (unresolvable relation fails loud) |
| 8 | 187 | OrmPermissionPolicy where-path > fallbacks > :any grant skips policies entirely | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B20 (unconditional grant, no residual) |
| 9 | 202 | OrmPermissionPolicy where-path > a policy runs exactly once per query > clone() does not re-run the policy | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B21 (residual applied once) |
| 10 | 221 | OrmPermissionPolicy where-path > a policy runs exactly once per query > a Lazy policy is not re-run when the deferred statement compiles | rewrite | C1 → T1 | authz-orm/test/ported/; B20 (deferred statement compiles the awaited filter once) |
| 11 | 239 | OrmPermissionPolicy where-path > insert > insert uses authorizeCreate and suppresses OwnerField stamping | rewrite | C1 → T1 | authz-orm/test/ported/; B20 (insert: authorizeCreate or @Owner stamp) |
| 12 | 253 | OrmPermissionPolicy where-path > insert > awaits an async authorizeCreate before the row lands (allow path) | rewrite | C1 → T1 | authz-orm/test/ported/; B20 (async authorizeCreate awaited) |
| 13 | 268 | OrmPermissionPolicy where-path > insert > a rejecting async authorizeCreate prevents the insert | rewrite | C1 → T1 | authz-orm/test/ported/; B20 (rejecting authorizeCreate blocks the insert) |
| 14 | 283 | OrmPermissionPolicy where-path > insert > OwnerField model with no policy stamps the owner column on insert | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B15 (@Owner stamp on insert) |
| 15 | 295 | OrmPermissionPolicy where-path > insert > a registered policy implementing only scope() falls back to OwnerField and stamps the owner column (IDOR closure) | rewrite | C1 → T1 | authz-orm/test/ported/; SR IDOR suite; B20, B15 (@Owner stamp closes the IDOR) |
| 16 | 311 | OrmPermissionPolicy where-path > insert > a registered policy with no authorizeCreate override and no OwnerField still denies, as Forbidden | rewrite | C1 → T1 | authz-orm/test/ported/; B20 (no authorizeCreate and no @Owner ends in 403) |
| 17 | 325 | OrmPermissionPolicy where-path > insert > model with neither policy nor OwnerField throws OrmException on :own insert | rewrite | C1 → T1 | authz-orm/test/ported/; B02, B20 |
| 18 | 336 | OrmPermissionPolicy where-path > insert > create:any skips authorizeCreate | rewrite | C1 → T1 | authz-orm/test/ported/; B20 (TRUE skips authorizeCreate) |
| 19 | 358 | OrmPermissionPolicy where-path > insert > multi-role OR-composition > first-success-wins: row lands via the second policy after the first rejects | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B03 (several relations OR; first permitting path wins) |
| 20 | 373 | OrmPermissionPolicy where-path > insert > multi-role OR-composition > all-reject: insert is rejected and the last policy error surfaces | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B03 (all rejected: insert refused) |
| 21 | 399 | OrmPermissionPolicy where-path > named scopes > a 'scope:subset' grant attribute routes to the named policy | rewrite | C1 → T1 | authz-orm/test/ported/; B15 (grant relation selects the named policy) |
| 22 | 414 | OrmPermissionPolicy where-path > named scopes > attributes ['*'] route to the default policy | rewrite | C1 → T1 | authz-orm/test/ported/; B15 (3.0: `:own ['*']` is relation `owner`, the default `@OrmScope` policy; design §18 converter table) |
| 23 | 428 | OrmPermissionPolicy where-path > named scopes > two roles with different scopes OR-compose | rewrite | C1 → T1 | authz-orm/test/ported/; B15 (several relations OR) |
| 24 | 453 | OrmPermissionPolicy where-path > named scopes > a '*'-attribute role does NOT absorb another role's scope token | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B11 (`:own ['*']` is relation `owner`, not an unconditional grant; two relations OR together and neither swallows the other) |
| 25 | 467 | OrmPermissionPolicy where-path > named scopes > KNOWN LIMITATION: a role's scope: token is silently absorbed by a role it $extends granting '*' on the same resource | rewrite | C1 → T1 | authz-orm/test/ported/; B12, B15 (expectation changes: B12 makes `extends` inherit grants and B15 ORs several relations, so `roleScopedExtender` holds `owner` OR `subset`; 3.0 runs both resolvers, `POLICY_CALLS` holds both and rows = `default-visible`, `subset-visible`; the 2.x known limitation goes away) |
| 26 | 491 | OrmPermissionPolicy where-path > named scopes > a granted scope with no registered policy throws OrmException | rewrite | C1 → T1 | authz-orm/test/ported/; B02, B15 (relation with no resolver is a config error) |
| 27 | 508 | OrmPermissionPolicy where-path > model-precise resolution (shared @OrmResource) > two unrelated models sharing one resource each resolve their OWN policy | rewrite | C1 → T1 | authz-orm/test/ported/; B21, B15 |
| 28 | 524 | OrmPermissionPolicy where-path > model-precise resolution (shared @OrmResource) > a shared-resource model with no own policy and no matching ancestor falls back to OwnerField | rewrite | C1 → T1 | authz-orm/test/ported/; B21, B15 |
| 29 | 538 | OrmPermissionPolicy where-path > model-precise resolution (shared @OrmResource) > a shared-resource model with no own policy, no matching ancestor and no OwnerField fails loud | rewrite | C1 → T1 | authz-orm/test/ported/; B21, B02 |
| 30 | 544 | OrmPermissionPolicy where-path > model-precise resolution (shared @OrmResource) > most-derived-wins: an exact-bound subclass policy shadows its ancestor-bound sibling | rewrite | C1 → T1 | authz-orm/test/ported/; B21, B15 (most-derived policy wins) |
| 31 | 552 | OrmPermissionPolicy where-path > model-precise resolution (shared @OrmResource) > the ancestor model still resolves its own policy when queried directly | rewrite | C1 → T1 | authz-orm/test/ported/; B21, B15 |

## test/orm-permission-registry.test.ts

`OrmPermissionPolicy` registration and the DI policy map. All rewrite (C1 → T1).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 56 | OrmPermissionPolicy registration > registers the default-scope policy under <resource>:default in the DI map as a single-entry list | rewrite | C1 → T1 | authz-orm/test/ported/; B21, B15 (@OrmScope registration; the DI map key is 2.x-internal, assert through the registry API) |
| 2 | 65 | OrmPermissionPolicy registration > registers a named scope independently of default | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B21 |
| 3 | 78 | OrmPermissionPolicy registration > records the bound model on the policy class | rewrite | C1 → T1 | authz-orm/test/ported/; B21 |
| 4 | 86 | OrmPermissionPolicy registration > a model sharing a resource name resolves the same policy (view over base table) | rewrite | C1 → T1 | authz-orm/test/ported/; B21 (several models share a type) |
| 5 | 100 | OrmPermissionPolicy registration > two structurally unrelated models sharing one resource+scope both register — no overwrite | rewrite | C1 → T1 | authz-orm/test/ported/; B21 |
| 6 | 116 | OrmPermissionPolicy registration > unknown resource/scope yields undefined from the map | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B02 (unknown relation resolver) |
| 7 | 121 | OrmPermissionPolicy registration > throws on duplicate registration for the same model+scope | rewrite | C1 → T1 | authz-orm/test/ported/; B02, B05 (duplicate registration refused at boot) |
| 8 | 136 | OrmPermissionPolicy registration > does NOT throw when a different model shares the resource+scope of an already-registered policy | rewrite | C1 → T1 | authz-orm/test/ported/; B21 |
| 9 | 151 | OrmPermissionPolicy registration > throws when the model carries no @OrmResource | rewrite | C1 → T1 | authz-orm/test/ported/; B02 (missing @AccessResource is a config error) |
| 10 | 161 | OrmPermissionPolicy registration > base class defaults: scopeRead/Update/Delete delegate to scope(), scope() and authorizeCreate() throw | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B20 (OrmScopePolicy defaults) |

## test/orm-rbac.test.ts

ORM query constraints and relation-join scoping. All rewrite (C1 → T1).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 57 | Orm rbac test > Rbac > should add statement on read:own permission | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B15 (read:own gives a relation residual) |
| 2 | 74 | Orm rbac test > Rbac > should throw forbidden when user has no permission | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B01 (FALSE gives AccessDenied, was Forbidden) |
| 3 | 91 | Orm rbac test > Rbac > should skip rbac check when SkipModelPermissionCheck is set | rewrite | C1 → T1 | authz-orm/test/ported/; B09, B21 (@Unscoped or runAs(SYSTEM) replaces SkipModelPermissionCheck) |
| 4 | 111 | Orm rbac test > Rbac relationScope join > should emit rbac constraint in relation JOIN ON clause, not in parent WHERE | rewrite | C1 → T1 | authz-orm/test/ported/; B20 (JOIN ON with relationScope join) |
| 5 | 133 | Orm rbac test > Rbac relationScope join > should still filter in WHERE on a root query | rewrite | C1 → T1 | authz-orm/test/ported/; B20 |
| 6 | 151 | Orm rbac test > Rbac relationScope join > should combine rbac constraint with user whereOnJoin OR group in JOIN ON clause | rewrite | C1 → T1 | authz-orm/test/ported/; B20 (OR/AND preserved) |
| 7 | 182 | Orm rbac test > Rbac relationScope join > should give each join a distinct alias when one model is joined twice | rewrite | C1 → T1 | authz-orm/test/ported/; B20, B21 |
| 8 | 205 | Orm rbac test > Rbac relationScope join > should not drop a parent whose relation is filtered by a joined table | rewrite | C1 → T1 | authz-orm/test/ported/; B20 |
| 9 | 225 | Orm rbac test > Rbac relationScope join > should not drop campaigns whose client type is filtered out | rewrite | C1 → T1 | authz-orm/test/ported/; B20 |

## test/ownership.test.ts

2.x model ownership helpers (`checkOwnership`, `ensureOwnership`). All rewrite (C1 → T1).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 58 | Model ownership helpers > checkOwnership(primaryKey) returns true for an owned resource | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B20 (owner relation resolver) |
| 2 | 63 | Model ownership helpers > checkOwnership(primaryKey) returns false for a resource owned by someone else | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B20 |
| 3 | 68 | Model ownership helpers > checkOwnership(model) returns true when the model instance is owned | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B20 |
| 4 | 73 | Model ownership helpers > checkOwnership(model) returns false when the model instance is not owned | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B20 |
| 5 | 78 | Model ownership helpers > ensureOwnership restricts a query to rows owned by the user | rewrite | C1 → T1 | authz-orm/test/ported/; B15, B20 (relation residual on the query) |
| 6 | 87 | Model ownership helpers > throws when the model has no @ResourceOwner() field | rewrite | C1 → T1 | authz-orm/test/ported/; B02, B15 (model without @Owner fails loud at config) |

## test/password.test.ts

Password hasher, validation provider `describe()` and password generator. Dominant class: move to `authn-local` (N3).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 42 | Password provider tests > Should hash password | move | N3 | `authn-local/test/` (N3 task 1): hasher moved; the stored prefix is pinned by A03 in a new test. |
| 2 | 49 | Password provider tests > Should verify password | move | N3 | `authn-local/test/` (N3 task 1): verifies a 2.x argon2i hash, which the argon2id hasher must still accept (rehash on login, A03). |
| 3 | 58 | Password provider tests > Should generate password | move | N3 | `authn-local/test/` (N3 tasks 1-2: hasher, policy, generator moved). |
| 4 | 86 | BasicPasswordValidationProvider.describe > lifts minLength, maxLength and pattern out of the configured schema | move | N3 | `authn-local/test/` (N3 tasks 1-2: hasher, policy, generator moved). |
| 5 | 92 | BasicPasswordValidationProvider.describe > carries the configured description verbatim and omits it when blank | move | N3 | `authn-local/test/` (N3 tasks 1-2: hasher, policy, generator moved). |
| 6 | 105 | BasicPasswordValidationProvider.describe > says nothing about a schema that carries none of the three keywords | move | N3 | `authn-local/test/` (N3 tasks 1-2: hasher, policy, generator moved). |
| 7 | 111 | BasicPasswordValidationProvider.describe > describes the same rule check() enforces | move | N3 | `authn-local/test/` (N3 tasks 1-2: hasher, policy, generator moved). |
| 8 | 140 | BasicPasswordProvider.generate > generates a password of the configured length from the configured characters | move | N3 | `authn-local/test/` (N3 tasks 1-2: hasher, policy, generator moved). |
| 9 | 154 | BasicPasswordProvider.generate > always returns a password satisfying the validation rule | move | N3 | `authn-local/test/` (N3 tasks 1-2: hasher, policy, generator moved). |
| 10 | 168 | BasicPasswordProvider.generate > throws a server error when the pool cannot satisfy the rule | move | N3 | `authn-local/test/` (N3 tasks 1-2: hasher, policy, generator moved). |
| 11 | 175 | BasicPasswordProvider.generate > does not repeat itself | move | N3 | `authn-local/test/` (N3 tasks 1-2: hasher, policy, generator moved). |
| 12 | 194 | BasicPasswordProvider.generate > falls back to the shipped default when authn.local.generator is not declared, but still throws when it is declared with an empty pool | move | N3 | `authn-local/test/` (N3 tasks 1-2: hasher, policy, generator moved). |

## test/permission-service.test.ts

`PermissionService` acting user, roles, grant projection and class-based resources. Dominant class: rewrite (C1 → T1). Rows 1-3 and 11-16 target `authz/test/ported/`, which plan §5 does not list for T1: B09 (`runAs`, principal resolution) and `assert` are core rules, so they belong to `authz`, not `authz-rbac`.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 73 | PermissionService > acting user resolution > an explicit user wins over the ambient one | rewrite | C1 → T1 | authz/test/ported/; B09 (explicit principal wins over the ambient one) |
| 2 | 79 | PermissionService > acting user resolution > falls back to the AsyncLocalStorage user | rewrite | C1 → T1 | authz/test/ported/; B09 (current() from the ambient store) |
| 3 | 85 | PermissionService > acting user resolution > throws when there is no user anywhere | rewrite | C1 → T1 | authz/test/ported/; B09 (no principal gives UNATTENDED, every check denies) |
| 4 | 91 | PermissionService > effective roles > answers the full role list outside any context | rewrite | C1 → T1 | authz-rbac/test/ported/; B11 (roles from live assignments) |
| 5 | 95 | PermissionService > effective roles > ActiveRole narrows the store's own user to that single role | rewrite | C1 → T1 | authz-rbac/test/ported/; B07, D14 (ActiveRole becomes ceiling.roles) |
| 6 | 102 | PermissionService > effective roles > ActiveRole does NOT narrow a different user | rewrite | C1 → T1 | authz-rbac/test/ported/; B07, D14 (a ceiling belongs to its own principal) |
| 7 | 110 | PermissionService > grant scope projection > projects any, own and none | rewrite | C1 → T1 | authz-rbac/test/ported/; B15, B20 (any gives TRUE, own gives a relation residual, none denies B01) |
| 8 | 116 | PermissionService > grant scope projection > any wins over own across a multi-role list | rewrite | C1 → T1 | authz-rbac/test/ported/; B11, B15 (unconditional grant wins over relation residual) |
| 9 | 120 | PermissionService > grant scope projection > an unknown role counts as none instead of leaking AccessControlError | rewrite | C1 → T1 | authz-rbac/test/ported/; B12 (unknown role ignored with a warning, no error) |
| 10 | 124 | PermissionService > grant scope projection > projects through the ActiveRole narrowing for the ambient user | rewrite | C1 → T1 | authz-rbac/test/ported/; B07, D14, B15 |
| 11 | 133 | PermissionService > assertGrant > answers the acting user and scope on a grant | rewrite | C1 → T1 | authz/test/ported/; B01, B15 (check answers allowed and residual) |
| 12 | 139 | PermissionService > assertGrant > throws Forbidden naming verb and resource when there is no grant | rewrite | C1 → T1 | authz/test/ported/; B01, B02 (AccessDenied carries permission, resource, reason) |
| 13 | 143 | PermissionService > assertGrant > a subclass error factory replaces the default error | rewrite | C1 → T1 | authz/test/ported/; B01 (app error through errorFor(reason), design §21 mapping table) |
| 14 | 150 | PermissionService > withUser > a different user impersonates: User swapped, ActiveRole cleared, other store keys kept | rewrite | C1 → T1 | authz/test/ported/; B09 (`runAs` swaps the principal), B07 (the ceiling is not carried over) |
| 15 | 161 | PermissionService > withUser > the store's own user reuses the ambient store untouched | rewrite | C1 → T1 | authz/test/ported/; B09 |
| 16 | 172 | PermissionService > withUser > runs outside any ambient context too, and answers the callback result | rewrite | C1 → T1 | authz/test/ported/; B09 (runAs outside any ambient context) |
| 17 | 178 | PermissionService > usePermission > answers the DI-cached instance of the requested service | drop | T1 | usePermission DI helper has no 3.0 counterpart; PermissionService is replaced by authz().assert/check (design §21 mapping) |
| 18 | 186 | PermissionService > usePermission > refuses a class that is not a PermissionService | drop | T1 | usePermission DI helper has no 3.0 counterpart; PermissionService is replaced by authz().assert/check (design §21 mapping) |
| 19 | 193 | PermissionService > probeGrant > answers the accesscontrol Permission for a granted role and null for an unknown one | rewrite | C1 → T1 | authz-rbac/test/ported/; B11, B12 (check on a granted role vs an unknown role) |
| 20 | 232 | PermissionService > class-based Resource > the class NAME is the grant key — no string restated, no metadata lookup | rewrite | C1 → T1 | authz-rbac/test/ported/; B02 (type name is the permission resource key) |
| 21 | 236 | PermissionService > class-based Resource > a resource class unknown to the grants fails loud, not closed | rewrite | C1 → T1 | authz-rbac/test/ported/; B02 (unregistered permission or resource fails loud) |
| 22 | 243 | PermissionService > class-based Resource > assert > any scope passes with or without a subject, never consulting owns() | rewrite | C1 → T1 | authz-rbac/test/ported/; B15, B06 (unconditional grant passes with or without subject) |
| 23 | 249 | PermissionService > class-based Resource > assert > none scope refuses with noPermissionError | rewrite | C1 → T1 | authz-rbac/test/ported/; B01 (no grant denies) |
| 24 | 253 | PermissionService > class-based Resource > assert > own scope passes when owns() answers true | rewrite | C1 → T1 | authz-rbac/test/ported/; B06, B15 (own relation true for the subject) |
| 25 | 258 | PermissionService > class-based Resource > assert > own scope refuses when owns() answers false | rewrite | C1 → T1 | authz-rbac/test/ported/; B06, B15 |
| 26 | 262 | PermissionService > class-based Resource > assert > own scope refuses a missing subject — ownership of nothing is undecidable | rewrite | C1 → T1 | authz-rbac/test/ported/; B06, B15 (3.0 differs: without a subject a conditional permit returns allowed with a residual, it does not refuse) |
| 27 | 286 | PermissionService > class-based Resource > chain > runs queued steps in call order on await | drop | T1 | ResourceRules chain builder (queued assert*/can* steps) has no 3.0 counterpart; domain rules become RelationResolver/ownsBy (design §21 mapping) |
| 28 | 294 | PermissionService > class-based Resource > chain > nothing runs before the chain is awaited | drop | T1 | ResourceRules chain builder (queued assert*/can* steps) has no 3.0 counterpart; domain rules become RelationResolver/ownsBy (design §21 mapping) |
| 29 | 302 | PermissionService > class-based Resource > chain > fails fast — a rejected step stops the chain and later steps never run | drop | T1 | ResourceRules chain builder (queued assert*/can* steps) has no 3.0 counterpart; domain rules become RelationResolver/ownsBy (design §21 mapping) |
| 30 | 309 | PermissionService > class-based Resource > chain > exposes only assert*/can* rule methods, and a rule-shaped typo dies at build time | drop | T1 | ResourceRules chain builder (queued assert*/can* steps) has no 3.0 counterpart; domain rules become RelationResolver/ownsBy (design §21 mapping) |
| 31 | 322 | PermissionService > class-based Resource > chain > awaiting the same chain twice runs it once | drop | T1 | ResourceRules chain builder (queued assert*/can* steps) has no 3.0 counterpart; domain rules become RelationResolver/ownsBy (design §21 mapping) |
| 32 | 332 | PermissionService > class-based Resource > chain > composes the generic verb gate with a domain rule on a ResourceRules service | rewrite | C1 → T1 | authz-rbac/test/ported/; B15, B23 (generic verb gate plus a domain relation rule) |

## test/session-codec.test.ts

Session data codec round-trips. Dominant class: move to `authn-session` (N2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 6 | Session data codec (encodeSessionData / decodeSessionData) > round-trips primitive value types (string, number, boolean, null) | move | N2 | `authn-session/test/` (N2 task 1: codec moved). |
| 2 | 23 | Session data codec (encodeSessionData / decodeSessionData) > round-trips a DateTime value as a DateTime (symmetric replacer/reviver — B5) | move | N2 | `authn-session/test/` (N2 task 1: codec moved). |
| 3 | 34 | Session data codec (encodeSessionData / decodeSessionData) > round-trips nested Map and Set values | move | N2 | `authn-session/test/` (N2 task 1: codec moved). |
| 4 | 50 | Session data codec (encodeSessionData / decodeSessionData) > decodes an empty map | move | N2 | `authn-session/test/` (N2 task 1: codec moved). |
| 5 | 86 | Session data codec (encodeSessionData / decodeSessionData) > object branch (json column / already-parsed payload) > decodes a parsed object to exactly the same session as the equivalent JSON text | move | N2 | `authn-session/test/` (N2 task 1: codec moved). |
| 6 | 95 | Session data codec (encodeSessionData / decodeSessionData) > object branch (json column / already-parsed payload) > rebuilds arrays of Maps, nested plain objects and nulls from the object form | move | N2 | `authn-session/test/` (N2 task 1: codec moved). |
| 7 | 115 | Session data codec (encodeSessionData / decodeSessionData) > object branch (json column / already-parsed payload) > installs a literal __proto__ key as an own property on both paths, never on the prototype | move | N2 | `authn-session/test/` (N2 task 1: codec moved). |
| 8 | 132 | Session data codec (encodeSessionData / decodeSessionData) > object branch (json column / already-parsed payload) > throws instead of returning an empty session when the payload is neither string nor object | move | N2 | `authn-session/test/` (N2 task 1: codec moved). |

## test/session-cookie.test.ts

Session cookie attributes, max age, shipped cookie config and session id hash. Mixed: move and adapt in `authn-session` (N2); the "auto" secure and `__Host-` setting (A07) needs fixture edits.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 6 | sessionCookieMaxAge > derives cookie maxAge (ms) from the session Expiration relative to now (B1) | move | N2 | `authn-session/test/` (N2 task 1: cookie builder moved). |
| 2 | 18 | sessionCookieMaxAge > returns undefined when the session never expires (no Expiration) | move | N2 | `authn-session/test/` (N2 task 1: cookie builder moved). |
| 3 | 25 | sessionCookieMaxAge > clamps to 0 for an already-expired session (never negative) | move | N2 | `authn-session/test/` (N2 task 1: cookie builder moved). |
| 4 | 40 | session cookie attributes > is Secure, HttpOnly and SameSite=Strict with no configuration at all | adapt | N2 | `authn-session/test/` A07: `secure` is "auto" by app env; set the env to production to keep the expected `true`. |
| 5 | 48 | session cookie attributes > cannot be downgraded to a javascript-readable cookie by configuration | move | N2 | `authn-session/test/` (N2 task 1: cookie builder moved). |
| 6 | 56 | session cookie attributes > lets an application relax secure / sameSite deliberately | adapt | N2 | `authn-session/test/` A07: `secure` and `sameSite` stay configurable; edit for the "auto" setting. |
| 7 | 63 | session cookie attributes > passes unknown express options through | move | N2 | `authn-session/test/` (N2 task 1: cookie builder moved). |
| 8 | 70 | session cookie attributes > defaults to the ssid name and honors a configured one | adapt | N2 | `authn-session/test/` A07: default name may gain a `__Host-` prefix by env; keep `ssid` when the prefix is off. |
| 9 | 75 | session cookie attributes > emits __Host- prefixed cookies with everything that prefix requires | adapt | N2 | `authn-session/test/` A07: `hostPrefix` becomes the "auto" prefix setting; the forced attributes stay. |
| 10 | 86 | session cookie attributes > carries the session id, is signed, and expires with the session | move | N2 | `authn-session/test/` (N2 task 1: cookie builder moved). |
| 11 | 95 | session cookie attributes > clears with an empty value and an immediate expiry, keeping the hardened flags | adapt | N2 | `authn-session/test/` A07: same "auto" `secure` note as row 1. |
| 12 | 125 | shipped session cookie configuration > ships Secure cookies in production | adapt | N2 | `authn-session/test/` Config module moves to `authn-session`; A07 "auto" setting replaces the boolean. The test switches on `NODE_ENV` at import time (SR-16); A07/A24 decide on the configuration env, so the 3.0 test must set the config env. |
| 13 | 131 | shipped session cookie configuration > relaxes Secure outside production so http://localhost can log in | adapt | N2 | `authn-session/test/` Config module moves to `authn-session`; A07 "auto" setting (development and test relax `secure`). Same config-env note as row 12. |
| 14 | 139 | hashSessionId > is stable for the same id and different for another | adapt | N2 | `authn-session/test/` A07: sessions stored hashed; digest and handle format may change. |
| 15 | 144 | hashSessionId > never contains the id itself — it is what goes into logs and API responses | adapt | N2 | `authn-session/test/` A07: handle length (`^[0-9a-f]{32}$`) may change with the hash. |

## test/session-expiration.test.ts

Absolute, sliding and sliding-capped expiration strategies. Dominant class: move to `authn-session` (N2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 46 | Session expiration strategies > AbsoluteExpiration > initial = Creation + ttl (minutes) | move | N2 | `authn-session/test/` (N2 task 1: strategies moved). |
| 2 | 57 | Session expiration strategies > AbsoluteExpiration > renew returns the current Expiration unchanged (no slide) | move | N2 | `authn-session/test/` (N2 task 1: strategies moved). |
| 3 | 70 | Session expiration strategies > SlidingExpiration > initial = now + ttl (minutes) | move | N2 | `authn-session/test/` (N2 task 1: strategies moved). |
| 4 | 79 | Session expiration strategies > SlidingExpiration > renew = now + ttl (slides forward from now, ignoring Creation) | move | N2 | `authn-session/test/` (N2 task 1: strategies moved). |
| 5 | 91 | Session expiration strategies > SlidingCappedExpiration > initial = now + ttl | move | N2 | `authn-session/test/` (N2 task 1: strategies moved). |
| 6 | 100 | Session expiration strategies > SlidingCappedExpiration > renew slides to now + ttl when under the cap | move | N2 | `authn-session/test/` (N2 task 1: strategies moved). |
| 7 | 110 | Session expiration strategies > SlidingCappedExpiration > renew clamps to Creation + maxLifetime when the slide would exceed the cap | move | N2 | `authn-session/test/` (N2 task 1: strategies moved). |

## test/session-regenerate.test.ts

Session fixation protection through `regenerateSession`. Dominant class: adapt in `authn-session` (N2, `SessionIssuer.rotate`).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 31 | regenerateSession (session-fixation protection) > mints a new SessionId different from the old one | adapt | N2 | `authn-session/test/` (A07): `regenerateSession(provider, old)` becomes `SessionIssuer.rotate`; fake provider keyed by the hashed id. |
| 2 | 42 | regenerateSession (session-fixation protection) > copies UserId, Creation and Data to the new session | adapt | N2 | `authn-session/test/` (A07): `regenerateSession(provider, old)` becomes `SessionIssuer.rotate`; fake provider keyed by the hashed id. |
| 3 | 54 | regenerateSession (session-fixation protection) > copies Data into a distinct map (mutating the new session does not affect the old) | adapt | N2 | `authn-session/test/` (A07): `regenerateSession(provider, old)` becomes `SessionIssuer.rotate`; fake provider keyed by the hashed id. |
| 4 | 64 | regenerateSession (session-fixation protection) > deletes the old session id and saves the new one | adapt | N2 | `authn-session/test/` (A07): `regenerateSession(provider, old)` becomes `SessionIssuer.rotate`; fake provider keyed by the hashed id. |

## test/session.test.ts

`MemorySessionStore` save, restore and delete. Dominant class: move to `authn-session` (N2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 23 | Session provider tests > should update & restore session | move | N2 | `authn-session/test/` (N2 task 1: `MemorySessionStore` moved). |
| 2 | 34 | Session provider tests > should delete session | move | N2 | `authn-session/test/` (N2 task 1: `MemorySessionStore` moved). |

## test/system-user-factory.test.ts

`RbacSystemUserFactory` must bypass row scope. Dominant class: rewrite (C1 → T1; `runAs(SYSTEM)`, B09).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 104 | RbacSystemUserFactory > returns an instance of the registered user model, not the base class | rewrite | C1 → T1 | `users/test/v3/` (B09): the system-user lookup runs under `runAs(SYSTEM, …)` (C1 task 4) and still returns the registered user model. |
| 2 | 111 | RbacSystemUserFactory > is not row-scoped by the registered model rbac hook | rewrite | C1 → T1 | `users/test/v3/` (B09, B20): `SYSTEM` consults no model, so no row scope; replaces `OrmPermissionPolicy` and `AccessControl` setup. |
| 3 | 125 | RbacSystemUserFactory > control: the same query IS scoped without the skip | rewrite | C1 → T1 | `users/test/v3/` (B20): control case with an `@OrmScope` residual that hides the row outside `runAs(SYSTEM)`. |
| 4 | 136 | RbacSystemUserFactory > preserves the surrounding store rather than replacing it | rewrite | C1 → T1 | `users/test/v3/` (B09): the surrounding store (principal, active role as ceiling) stays; `SkipModelPermissionCheck` is gone. |

## test/unwind-grants.test.ts

`_unwindGrants` and `_combineGrants`, 2.x internals. All drop (T1; plan §5 names them).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 27 | _unwindGrants > keeps the role own actions on a resource an inherited role also grants | drop | T1 | _unwindGrants is a 2.x internal; role inheritance is covered by the B12 tests of authz-rbac |
| 2 | 42 | _unwindGrants > pulls in resources from every inherited role | drop | T1 | 2.x internal; inheritance covered by B12 |
| 3 | 47 | _unwindGrants > does not leak $extend into the resource map | drop | T1 | 2.x internal; no $extend key in 3.0 role config |
| 4 | 51 | _unwindGrants > answers like accesscontrol does for the same role | drop | T1 | compares against the accesscontrol library, removed in 3.0 |
| 5 | 65 | _unwindGrants > lets the role override an action inherited from an extended role | drop | T1 | 2.x internal; inheritance covered by B12 |
| 6 | 74 | _unwindGrants > returns an empty map for an unknown role | drop | T1 | 2.x internal; unknown roles covered by B12 |
| 7 | 78 | _unwindGrants > terminates on a cyclic $extend | drop | T1 | 2.x internal; a cycle is an AuthzConfigError at boot under B12 (new test belongs to authz-rbac) |
| 8 | 89 | _unwindGrants > does not mutate the source grants | drop | T1 | 2.x internal |
| 9 | 97 | _combineGrants > merges per action across roles instead of replacing the resource | drop | T1 | _combineGrants is a 2.x internal; role union covered by B11 |
| 10 | 107 | _combineGrants > returns an empty map when given nothing | drop | T1 | 2.x internal |

## test/user-model-token.test.ts

DI token for the registered user model. Dominant class: adapt (C1).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 14 | RbacUserModel token > falls back to the shipped User class when nothing is registered | adapt | C1 | users/test/ Token `RBAC_USER_MODEL` / `RbacBootstrapper` renamed with the `users` package (identity concern, not authorization). |
| 2 | 18 | RbacUserModel token > bootstrapper registers the default exactly once | adapt | C1 | users/test/ Token `RBAC_USER_MODEL` / `RbacBootstrapper` renamed with the `users` package (identity concern, not authorization). |
| 3 | 23 | RbacUserModel token > application override wins whether it registers before or after the bootstrapper | adapt | C1 | users/test/ Token `RBAC_USER_MODEL` / `RbacBootstrapper` renamed with the `users` package (identity concern, not authorization). |

## test/user.test.ts

User model: query scopes, roles, `can*` checks, metadata and model behaviour. Plan §5 lists `user` (44) as a rewrite-class suite for T1. The ledger splits it: scope, metadata and model tests (33 adapt, C1) do not touch authorization and stay in `users`; roles and `can*` checks (10 rewrite) go to T1; 1 drop (the `Role` column is gone, H13).

Mixed file: C1 splits it. Kept rows stay or move as classed; rewrite rows go to `test/legacy-v2/user.test.ts`, which T1 deletes once the replacements named in Target exist.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 49 | User model tests > Scope tests > isActiveUser query scope should work | adapt | C1 | users/test/ (seed users without Role, H13) |
| 2 | 54 | User model tests > Scope tests > whereEmail query scope should work | adapt | C1 | users/test/ (seed users without Role, H13) |
| 3 | 59 | User model tests > Scope tests > whereLogin query scope should work | adapt | C1 | users/test/ (seed users without Role, H13) |
| 4 | 64 | User model tests > Scope tests > getByLogin should work | adapt | C1 | users/test/ (seed users without Role, H13) |
| 5 | 69 | User model tests > Scope tests > getByEmail should work | adapt | C1 | users/test/ (seed users without Role, H13) |
| 6 | 74 | User model tests > Scope tests > getByUuid should work | adapt | C1 | users/test/ (seed users without Role, H13) |
| 7 | 79 | User model tests > Scope tests > whereAnything should find a user by login | adapt | C1 | users/test/ (seed users without Role, H13) |
| 8 | 85 | User model tests > Scope tests > whereAnything should find a user by email | adapt | C1 | users/test/ (seed users without Role, H13) |
| 9 | 90 | User model tests > Scope tests > whereAnything should find a user by id | adapt | C1 | users/test/ (seed users without Role, H13) |
| 10 | 98 | User model tests > Scope tests > whereAnything should find a user by a numeric id passed as string | adapt | C1 | users/test/ (seed users without Role, H13) |
| 11 | 110 | User model tests > Scope tests > whereAnything should find a user by a uuid that starts with a digit | adapt | C1 | users/test/ (seed users without Role, H13) |
| 12 | 127 | User model tests > Scope tests > whereAnything should find a user by a login that starts with a digit | adapt | C1 | users/test/ (seed users without Role, H13) |
| 13 | 144 | User model tests > User roles > Should check if guest role is set by default | rewrite | C1 → T1 | users/test/v3/; B11, B12 (roles as assignments; default roles through AuthzAdmin.assign, plan C1 tasks 3 and 6; H13) A raw `new User().insert()` gets no role in 3.0: only `create()` assigns default roles (C1 task 3, H13). |
| 14 | 162 | User model tests > User roles > Should save multiple roles | rewrite | C1 → T1 | users/test/v3/; B11, B12 (roles as assignments; default roles through AuthzAdmin.assign, plan C1 tasks 3 and 6; H13) |
| 15 | 178 | User model tests > User roles > Should convert roles to and from string to array | drop | T1 | users.Role column and its @Set string conversion are removed (H13); multi-role storage is covered by the B11 assignment tests |
| 16 | 221 | User model tests > Permission checks (can*) > canReadAny should work | rewrite | C1 → T1 | authz-rbac/test/ported/; B11, B15 (User.can* replaced by authz().check; an :any grant covers :own as an unconditional grant) |
| 17 | 226 | User model tests > Permission checks (can*) > canUpdateAny should work | rewrite | C1 → T1 | authz-rbac/test/ported/; B11, B15 (User.can* replaced by authz().check; an :any grant covers :own as an unconditional grant) |
| 18 | 231 | User model tests > Permission checks (can*) > canDeleteAny should work | rewrite | C1 → T1 | authz-rbac/test/ported/; B11, B15 (User.can* replaced by authz().check; an :any grant covers :own as an unconditional grant) |
| 19 | 236 | User model tests > Permission checks (can*) > canCreateAny should work | rewrite | C1 → T1 | authz-rbac/test/ported/; B11, B15 (User.can* replaced by authz().check; an :any grant covers :own as an unconditional grant) |
| 20 | 241 | User model tests > Permission checks (can*) > canReadOwn should work | rewrite | C1 → T1 | authz-rbac/test/ported/; B11, B15 (User.can* replaced by authz().check; an :any grant covers :own as an unconditional grant) |
| 21 | 247 | User model tests > Permission checks (can*) > canUpdateOwn should work | rewrite | C1 → T1 | authz-rbac/test/ported/; B11, B15 (User.can* replaced by authz().check; an :any grant covers :own as an unconditional grant) |
| 22 | 252 | User model tests > Permission checks (can*) > canDeleteOwn should work | rewrite | C1 → T1 | authz-rbac/test/ported/; B11, B15 (User.can* replaced by authz().check; an :any grant covers :own as an unconditional grant) |
| 23 | 257 | User model tests > Permission checks (can*) > canCreateOwn should work | rewrite | C1 → T1 | authz-rbac/test/ported/; B11, B15 (User.can* replaced by authz().check; an :any grant covers :own as an unconditional grant) |
| 24 | 264 | User model tests > User metadata > Should get metadata | adapt | C1 | users/test/ (seed users without Role, H13) |
| 25 | 274 | User model tests > User metadata > Should add metadata by assign | adapt | C1 | users/test/ (seed users without Role, H13) |
| 26 | 286 | User model tests > User metadata > Should remove specific metadata by assingn  | adapt | C1 | users/test/ (seed users without Role, H13) |
| 27 | 299 | User model tests > User metadata > Should remove all meta in category by assign | adapt | C1 | users/test/ (seed users without Role, H13) |
| 28 | 317 | User model tests > User metadata > Should update metadata | adapt | C1 | users/test/ (seed users without Role, H13) |
| 29 | 336 | User model tests > User metadata > Should automatically convert meta value to number | adapt | C1 | users/test/ (seed users without Role, H13) |
| 30 | 347 | User model tests > User metadata > Should automatically convert meta value to json | adapt | C1 | users/test/ (seed users without Role, H13) |
| 31 | 358 | User model tests > User metadata > Should automatically convert meta value to boolean | adapt | C1 | users/test/ (seed users without Role, H13) |
| 32 | 369 | User model tests > User metadata > Should automatically convert meta value to datetime | adapt | C1 | users/test/ (seed users without Role, H13) |
| 33 | 380 | User model tests > User metadata > Should filter metadata by key | adapt | C1 | users/test/ (seed users without Role, H13) |
| 34 | 388 | User model tests > User metadata > Should find metadata by key | adapt | C1 | users/test/ (seed users without Role, H13) |
| 35 | 398 | User model tests > Model tests > Should get user by email | adapt | C1 | users/test/ (seed users without Role, H13) |
| 36 | 406 | User model tests > Model tests > Should get user by login | adapt | C1 | users/test/ (seed users without Role, H13) |
| 37 | 411 | User model tests > Model tests > Should get user by uuid | adapt | C1 | users/test/ (seed users without Role, H13) |
| 38 | 416 | User model tests > Model tests > Should get user by id | adapt | C1 | users/test/ (seed users without Role, H13) |
| 39 | 421 | User model tests > Model tests > Should throw if same email is used | adapt | C1 | users/test/ (seed users without Role, H13) |
| 40 | 436 | User model tests > Model tests > Should throw if same uuid is used | adapt | C1 | users/test/ (seed users without Role, H13) |
| 41 | 451 | User model tests > Model tests > Should throw if same login is used | adapt | C1 | users/test/ (seed users without Role, H13) |
| 42 | 466 | User model tests > Model tests > Should set soft delete date | adapt | C1 | users/test/ (seed users without Role, H13) |
| 43 | 479 | User model tests > Model tests > Should hide soft deleted rows from normal reads | adapt | C1 | users/test/ (seed users without Role, H13) |
| 44 | 486 | User model tests > Model tests > To json should hide password | adapt | C1 | users/test/ (seed users without Role, H13) |

## test/write-ownership-idor.test.ts

Ownership enforcement on UPDATE and DELETE, a 2.x IDOR regression. All rewrite (C1 → T1); none dropped, they map to the T1 IDOR suite.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 82 | Ownership enforcement on write queries (IDOR regression) > UPDATE with :own scope cannot touch another user's row via an OR lookup | rewrite | C1 → T1 | authz-orm/test/ported/; SR IDOR suite; B20, B15 (relation residual ANDed around the caller OR group) |
| 2 | 99 | Ownership enforcement on write queries (IDOR regression) > DELETE with :own scope cannot delete another user's row in a multi-key destroy | rewrite | C1 → T1 | authz-orm/test/ported/; SR IDOR suite; B20, B15 (relation residual ANDed around the caller OR group) |
