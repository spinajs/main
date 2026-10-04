# spinajs-authz-convert warnings

Inputs: test/fixtures/golden/default-2.0.546/config; layers: common.
The converter ran the config files, so a value a file computes (from process.env, the clock, …) is written as the value it had during the run. Check such keys by hand.

## Convert by hand (0)

The converter left these out (or wrote them as found) because it cannot convert them without guessing. Boot may fail until they are done.

None.

## Behaviour changes and actions (13)

Converted, but 3.0 behaves differently here, or the app must act.

- [common] `rbac.grants.user.user["read:own"]`: :own on 'user' became relation 'self' (the caller's own account). If the app registered a default OrmPermission policy for 'user', 2.x used it here and 'self' ignores it; pass --self-resources without 'user' to get relation 'owner' instead. (self-relation)
- [common] `rbac.grants.user.user["update:own"]`: :own on 'user' became relation 'self' (the caller's own account). If the app registered a default OrmPermission policy for 'user', 2.x used it here and 'self' ignores it; pass --self-resources without 'user' to get relation 'owner' instead. (self-relation)
- [common] `rbac.roles[0]`: Declared role 'Admin' differs from the granted role 'admin' only in case, so it was not written (names keep their case, H17). In 2.x a user holding 'Admin' with other roles got no permission at all (accesscontrol refused the role list); in 3.0 'Admin' is ignored and the other roles apply. (role-case)
- [common] `rbac.roles[1]`: Declared role 'User' differs from the granted role 'user' only in case, so it was not written (names keep their case, H17). In 2.x a user holding 'User' with other roles got no permission at all (accesscontrol refused the role list); in 3.0 'User' is ignored and the other roles apply. (role-case)
- [common] `rbac.twoFactorAuth`: TOTP secrets are stored encrypted in 3.0: set authn.mfa.encryptionKey (a secret reference) before running the migrations, which refuse to run without it. (mfa-key)
- [common] `rbac.password.blockAfterAttempts`: After 5 failed logins 2.x locked the account; 3.0 never locks. It waits min(baseDelayMs × 2^(n − free), maxDelayMs) before each further attempt, per account and per IP (H31, A06). (lockout-to-backoff)
- [common] `rbac.password.lockoutTime`: Dropped: 3.0 never locks an account (H31). The nearest knob is authn.throttle.login.account.maxDelayMs. (lockout-time)
- [common] `UserBase`: :own grants on UserBase became relation 'owner'. Each model of type 'UserBase' needs @Owner() (was @ResourceOwner()) or an @OrmScope(Model, 'owner') policy (was a default-scope @OrmPermission policy); route checks need a RelationResolver. Run with --src to check the models. (owner-relation)
- [common] `user.metadata`: :own grants on user.metadata became relation 'owner'. Each model of type 'user.metadata' needs @Owner() (was @ResourceOwner()) or an @OrmScope(Model, 'owner') policy (was a default-scope @OrmPermission policy); route checks need a RelationResolver. Run with --src to check the models. (owner-relation)
- [common] `http.trustProxy`: http.trustProxy is not set. Behind a proxy, set it to the hop count or the proxy CIDRs, or every client shares the proxy address for throttling and audit. (trust-proxy)
- [common] `http.cors.origins`: 2.x answered every origin, with credentials, when http.cors.origins was empty or unset; 3.0 then allows no cross-origin request (H33, A31). List every origin a browser client uses (and in authn.http.csrf.allowedOrigins for cookie sessions). (cors-empty)
- [common] `rbac.session.cookie`: The session cookie becomes '__Host-ssid' outside development and test (authn.session.cookie.hostPrefix 'auto'). Every 2.x session is logged out at the upgrade, and clients that send 'ssid' by name must change. (cookie-rename)
- [common] `rbac.session.cookie.secure`: secure: false alone no longer relaxes the cookie: hostPrefix 'auto' forces Secure outside development and test. For local http set authn.session.cookie.hostPrefix: false in a development config. (cookie-secure)

## Notes (4)

Converted as the migration guide describes.

- [common] `rbac.requireKnownRole`: Removed: 3.0 always refuses unknown roles. (removed)
- [common] `rbac.systemRole`: Removed: SYSTEM is a principal in 3.0; the role 'system' stays an ordinary role. (removed)
- [common] Roles only used through $extend: 'admin.users', 'admin'. With --db the converter marks those no user or token holds 'assignable: false'; without it every role stays assignable, as in 2.x. (assignable)
- [common] `user`: :own grants on user became relation 'self' (the caller's own account); a RelationResolver for 'self' on type 'user' must exist in 3.0. (relation-self)
