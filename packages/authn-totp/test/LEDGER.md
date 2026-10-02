# Test ledger: @spinajs/authn-totp

Every `it` of the 2.x suite of this package at `3d22b6c8f`, classified per
plan §1 rule 6 (F5). Classes: move, adapt, rewrite, drop (definitions:
`.authz-sdd/F5-task-7-brief.md`, kept in the header below).
Rewrite-class files go to `test/legacy-v2/` in their C/N lane; the T lane
replaces them and deletes the legacy file.

- **move**: the test's code and assertions stay as they are; only the file moves to another package because the code under test moves there.
- **adapt**: the test stays (in this package, or in the package the code moves to) with mechanical edits that keep its intent and its expected values.
- **rewrite**: the test asserts 2.x authorization API or behaviour that 3.0 replaces, or 2.x authentication behaviour that an N lane redesigns; the owning lane moves the file to `test/legacy-v2/` and a T (or N) lane writes the 3.0 replacement, named in the Target column with the rule ids.
- **drop**: no 3.0 counterpart; the reason is in the Target column.

| Class | Count |
|---|---|
| move | 0 |
| adapt | 5 |
| rewrite | 16 |
| drop | 0 |
| **total** | 21 |

## test/otp-url.test.ts

5 tests; dominant class adapt (adapt 5).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 15 | buildOtpAuthUrl > builds otpauth url from base32 secret with given options | adapt | N5 | authn-totp/test/ (otpauth/QR helper kept, N5 task 4; only the import path may change) |
| 2 | 27 | buildOtpAuthUrl > normalizes lowercase and whitespace-separated secret | adapt | N5 | authn-totp/test/ (otpauth/QR helper kept, N5 task 4; only the import path may change) |
| 3 | 32 | buildOtpAuthUrl > passes full otpauth url through untouched | adapt | N5 | authn-totp/test/ (otpauth/QR helper kept, N5 task 4; only the import path may change) |
| 4 | 37 | buildOtpAuthUrl > throws on invalid base32 secret | adapt | N5 | authn-totp/test/ (otpauth/QR helper kept, N5 task 4; only the import path may change) |
| 5 | 41 | buildOtpAuthUrl > throws on empty input | adapt | N5 | authn-totp/test/ (otpauth/QR helper kept, N5 task 4; only the import path may change) |

## test/two-factor-enrolment.test.ts

6 tests; dominant class rewrite (rewrite 6).

Base state: at base (F0b) this file never ran; its `beforeEach` hook failed with `pwd.hash is not a function`. It is not a green reference for the N and T lanes.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 68 | Default2FaToken enrolment states > beginEnrolment stores the secret without enabling 2fa | rewrite | N5 | authn-totp/test/v3/ (A10, A12, SR-09): the none, pending, enabled states stay, but the secret lives encrypted in `authn_mfa` (`DbMfaStore`), not in `users_metadata` |
| 2 | 78 | Default2FaToken enrolment states > beginEnrolment replaces the secret of a pending enrolment | rewrite | N5 | authn-totp/test/v3/ (A10, A12, SR-09): the none, pending, enabled states stay, but the secret lives encrypted in `authn_mfa` (`DbMfaStore`), not in `users_metadata` |
| 3 | 88 | Default2FaToken enrolment states > beginEnrolment refuses on an already enabled account | rewrite | N5 | authn-totp/test/v3/ (A10, A12, SR-09): the none, pending, enabled states stay, but the secret lives encrypted in `authn_mfa` (`DbMfaStore`), not in `users_metadata` |
| 4 | 101 | Default2FaToken enrolment states > activate flips a pending enrolment to enabled | rewrite | N5 | authn-totp/test/v3/ (A10, A12, SR-09): the none, pending, enabled states stay, but the secret lives encrypted in `authn_mfa` (`DbMfaStore`), not in `users_metadata` |
| 5 | 109 | Default2FaToken enrolment states > activate refuses when there is no secret | rewrite | N5 | authn-totp/test/v3/ (A10, A12, SR-09): the none, pending, enabled states stay, but the secret lives encrypted in `authn_mfa` (`DbMfaStore`), not in `users_metadata` |
| 6 | 120 | Default2FaToken enrolment states > initialize still enables immediately | rewrite | N5 | authn-totp/test/v3/ (A10, A12, SR-10): no route enables MFA with a secret, so enabling with a secret survives only as a seeding helper of the test kit; the replacement asserts "admin MFA reset returns no secret" (SR-10) and that enrolment needs fresh auth (A13) |

## test/user-2fa-actions.test.ts

8 tests; dominant class rewrite (rewrite 8).

Base state: at base (F0b) this file never ran; its `beforeEach` hook failed with `pwd.hash is not a function`. It is not a green reference for the N and T lanes.

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 76 | 2FA actions > enable stores the secrets and returns the otpauth url | rewrite | N5 | authn-totp/test/v3/ (A10, A12, SR-09): enrol, confirm, disable, reset over `authn_mfa`; the `User2Fa*` events stay; `secretCount` over `UserMetadata` no longer applies |
| 2 | 84 | 2FA actions > enable emits User2FaEnabled for the user | rewrite | N5 | authn-totp/test/v3/ (A10, A12, SR-09): enrol, confirm, disable, reset over `authn_mfa`; the `User2Fa*` events stay; `secretCount` over `UserMetadata` no longer applies |
| 3 | 92 | 2FA actions > disable clears the secrets and emits User2FaDisabled | rewrite | N5 | authn-totp/test/v3/ (A10, A12, SR-09): enrol, confirm, disable, reset over `authn_mfa`; the `User2Fa*` events stay; `secretCount` over `UserMetadata` no longer applies |
| 4 | 105 | 2FA actions > reset clears the secrets and emits User2FaReset | rewrite | N5 | authn-totp/test/v3/ (A10, A25, SR-10): admin reset clears the secret, returns none, and needs the target guard |
| 5 | 118 | 2FA actions > reset leaves an account that never enabled 2fa untouched | rewrite | N5 | authn-totp/test/v3/ (A10): reset of an account without MFA is a no-op |
| 6 | 124 | 2FA actions > beginUser2FaEnrolment stores a secret but emits no enabled event | rewrite | N5 | authn-totp/test/v3/ (A10, A12, SR-09): enrol, confirm, disable, reset over `authn_mfa`; the `User2Fa*` events stay; `secretCount` over `UserMetadata` no longer applies |
| 7 | 134 | 2FA actions > confirmUser2Fa activates and emits User2FaEnabled on a valid code | rewrite | N5 | authn-totp/test/v3/ (A10, A12, SR-09): enrol, confirm, disable, reset over `authn_mfa`; the `User2Fa*` events stay; `secretCount` over `UserMetadata` no longer applies |
| 8 | 152 | 2FA actions > confirmUser2Fa rejects a wrong code and leaves the enrolment pending | rewrite | N5 | authn-totp/test/v3/ (A10): a wrong code leaves the enrolment pending and counts into the throttle (A05, A06) |

## test/z-2fa-throttle-finding.test.ts

2 tests; dominant class rewrite (rewrite 2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 71 | 2fa throttling ( finding R2 ) > R2: repeated wrong 2fa codes lock the account like failed logins do | rewrite | N5 | authn-totp/test/v3/ (A05, A06, A10, H31, SR-05): the 2.x lockout (lock instant in metadata after 5 failures) becomes backoff and nobody is locked; the expectation differs |
| 2 | 86 | 2fa throttling ( finding R2 ) > R2: a successful 2fa check clears the failure counter | rewrite | N5 | authn-totp/test/v3/ (A06, A10): a success resets the key; the counter lives in `authn_throttle`, not in `USER_LOGIN_ATTEMPTS` metadata |
