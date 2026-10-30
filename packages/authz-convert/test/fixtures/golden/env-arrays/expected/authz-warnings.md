# spinajs-authz-convert warnings

Inputs: test/fixtures/golden/env-arrays/config; layers: common, prod.
The converter ran the config files, so a value a file computes (from process.env, the clock, …) is written as the value it had during the run. Check such keys by hand.

## Convert by hand (1)

The converter left these out (or wrote them as found) because it cannot convert them without guessing. Boot may fail until they are done.

- [common] `rbac.twoFactorAuth`: 2.x @spinajs/rbac-http-user turned TOTP login on by default; 3.0 ships no MFA step. If the app installed rbac-http-user, add authn.mfa.steps: [{ name: 'totp', service: 'TotpMfaStep' }] and set authn.mfa.encryptionKey, or users enrolled in 2FA log in with the password alone. (mfa-default)

## Behaviour changes and actions (6)

Converted, but 3.0 behaves differently here, or the app must act.

- [common] `http.trustProxy`: http.trustProxy is not set. Behind a proxy, set it to the hop count or the proxy CIDRs, or every client shares the proxy address for throttling and audit. (trust-proxy)
- [common] `http.cookie.secret`: http.cookie.secret is not set, so 2.x signed cookies with the public @spinajs/http default. Set a secret of your own through a secret reference (env or a secret store). (cookie-secret)
- [common] `rbac.session.cookie`: The session cookie becomes '__Host-ssid' outside development and test (authn.session.cookie.hostPrefix 'auto'). Every 2.x session is logged out at the upgrade, and clients that send 'ssid' by name must change. (cookie-rename)
- [common] `rbac.password.expiration`: 2.x @spinajs/rbac expired passwords after 31 days unless the app turned it off; 3.0 never expires them unless authn.local.expiration.enabled is true. Set it (and maxAgeDays) if the app relied on the 2.x default. (password-expiry-default)
- [common] `rbac.password.blockAfterAttempts`: 2.x locked an account for 15 minutes after 5 failed logins (3 with @spinajs/rbac-http-user); 3.0 never locks and backs off instead, by default to at most 60 s per attempt (H31, A06). Tune authn.throttle.login if that is too weak. (lockout-default)
- [common] `rbac.defaultRole`: 2.x gave new users the role 'guest' by default. Nothing was written, and no 3.0 package lists authz.rbac.defaultRoles, so new users get no role; set it if the app relied on 'guest'. (default-role-default)

## Notes (4)

Converted as the migration guide describes.

- [common] `rbac.impersonation.protectedRoles`: 2.x joined rbac.impersonation.protectedRoles with the package value ["system"]; both parts were written. (package-array)
- [common] `rbac.password.generator.characters`: 2.x joined rbac.password.generator.characters with the package value ["abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ","0123456789"]; both parts were written. (package-array)
- [common] `rbac.auth.service`: 2.x logged users in with @spinajs/rbac's SimpleDbAuthProvider by default; authn.strategies lists the local password strategy. (auth-default)
- [common] `rbac.enableGuestAccount`: 2.x had no guest account by default. 3.0 turns the anonymous principal on, with the roles of authz.rbac.anonymousRoles; set authz.principals.anonymous.enabled: false to match 2.x exactly. (guest-default)
