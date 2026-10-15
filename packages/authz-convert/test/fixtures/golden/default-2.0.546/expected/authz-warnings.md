# spinajs-authz-convert warnings

Inputs: test/fixtures/golden/default-2.0.546/config; layers: common.
The converter ran the config files, so a value a file computes (from process.env, the clock, …) is written as the value it had during the run. Check such keys by hand.

## Convert by hand (1)

The converter left these out (or wrote them as found) because it cannot convert them without guessing. Boot may fail until they are done.

- [common] `rbac.session.cookie.secure`: rbac.session.cookie.secure changed when the config ran under another NODE_ENV; the converted value is the one of this run. Set the 3.0 key per env by hand. (computed-value)

## Behaviour changes and actions (14)

Converted, but 3.0 behaves differently here, or the app must act.

- [common] `rbac.grants.user.user["read:own"]`: :own on 'user' became relation 'self' (the caller's own account). If the app registered a default OrmPermission policy for 'user', 2.x used it here and 'self' ignores it; pass --self-resources without 'user' to get relation 'owner' instead. (self-relation)
- [common] `rbac.grants.user.user["update:own"]`: :own on 'user' became relation 'self' (the caller's own account). If the app registered a default OrmPermission policy for 'user', 2.x used it here and 'self' ignores it; pass --self-resources without 'user' to get relation 'owner' instead. (self-relation)
- [common] `rbac.roles[0]`: Declared role 'Admin' differs from the granted role 'admin' only in case, so it was not written (names keep their case, H17). In 2.x a user holding 'Admin' with other roles got no permission at all (accesscontrol refused the role list); in 3.0 'Admin' is ignored and the other roles apply. (role-case)
- [common] `rbac.roles[1]`: Declared role 'User' differs from the granted role 'user' only in case, so it was not written (names keep their case, H17). In 2.x a user holding 'User' with other roles got no permission at all (accesscontrol refused the role list); in 3.0 'User' is ignored and the other roles apply. (role-case)
- [common] `rbac.password.blockAfterAttempts`: After 5 failed logins 2.x locked the account; 3.0 never locks. It waits min(baseDelayMs × 2^(n − free), maxDelayMs) before each further attempt, per account and per IP (H31, A06). (lockout-to-backoff)
- [common] `rbac.password.lockoutTime`: Dropped: 3.0 never locks an account (H31). The nearest knob is authn.throttle.login.account.maxDelayMs. (lockout-time)
- [common] `authn.mfa.encryptionKey`: TOTP secrets are stored encrypted in 3.0: set authn.mfa.encryptionKey (a secret reference) before running the migrations, which refuse to run without it. (mfa-key)
- [common] test/fixtures/golden/default-2.0.546/config/rbac.js (or a module it imports) reads NODE_ENV from the environment; values derived from them were converted as this run saw them. Check the keys it sets. (reads-env)
- [common] `UserBase`: :own grants on UserBase became relation 'owner'. Each model of type 'UserBase' needs @Owner() (was @ResourceOwner()) on the column that holds the owner's id; route checks need a RelationResolver. Run with --src to check the models. (owner-relation)
- [common] `user.metadata`: :own grants on user.metadata became relation 'owner'. Each model of type 'user.metadata' needs @Owner() (was @ResourceOwner()) on the column that holds the owner's id; route checks need a RelationResolver. Run with --src to check the models. (owner-relation)
- [common] `http.trustProxy`: http.trustProxy is not set. Behind a proxy, set it to the hop count or the proxy CIDRs, or every client shares the proxy address for throttling and audit. (trust-proxy)
- [common] `http.cookie.secret`: http.cookie.secret is not set, so 2.x signed cookies with the public @spinajs/http default. Set a secret of your own through a secret reference (env or a secret store). (cookie-secret)
- [common] `rbac.session.cookie`: The session cookie becomes '__Host-ssid' outside development and test (authn.session.cookie.hostPrefix 'auto'). Every 2.x session is logged out at the upgrade, and clients that send 'ssid' by name must change. (cookie-rename)
- [common] `rbac.session.cookie.secure`: secure: false alone no longer relaxes the cookie: hostPrefix 'auto' forces Secure outside development and test. For local http set authn.session.cookie.hostPrefix: false in a development config. (cookie-secure)

## Notes (23)

Converted as the migration guide describes.

- [common] `rbac.grants.guest.UserBase["read:own"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants.system.$extend`: 2.x joined this $extend with the package's ["admin"]; only the app's part was written, and the 3.0 packages define their own 'system'. (package-extends)
- [common] `rbac.grants["admin.users"].users["create:any"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants["admin.users"].users["read:any"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants["admin.users"].users["update:any"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants["admin.users"].users["delete:any"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants["admin.users"]["user.metadata"]["create:any"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants["admin.users"]["user.metadata"]["read:any"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants["admin.users"]["user.metadata"]["update:any"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants["admin.users"]["user.metadata"]["delete:any"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants.user.user["read:own"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants.user.user["update:own"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants.user["user.metadata"]["create:own"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants.user["user.metadata"]["read:own"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants.user["user.metadata"]["update:own"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants.user["user.metadata"]["delete:own"]`: A 2.x package grants the same key; 2.x joined the lists and 3.0 keeps both grants, which is the same union. (package-grant)
- [common] `rbac.grants.admin.$extend`: 2.x joined this $extend with the package's ["admin.users"]; only the app's part was written, and the 3.0 packages define their own 'admin'. (package-extends)
- [common] `rbac.password.generator.characters`: 2.x joined rbac.password.generator.characters with the package value ["abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ","0123456789"]; both parts were written. (package-array)
- [common] `rbac.requireKnownRole`: Removed: 3.0 always refuses unknown roles. (removed)
- [common] `rbac.systemRole`: Removed: SYSTEM is a principal in 3.0; the role 'system' stays an ordinary role. (removed)
- [common] `rbac.impersonation.protectedRoles`: 2.x joined rbac.impersonation.protectedRoles with the package value ["system"]; both parts were written. (package-array)
- [common] Roles only used through $extend: 'admin.users', 'admin'. With --db the converter marks those no user or token holds 'assignable: false'; without it every role stays assignable, as in 2.x. (assignable)
- [common] `user`: :own grants on user became relation 'self' (the caller's own account); a RelationResolver for 'self' on type 'user' must exist in 3.0. (relation-self)
