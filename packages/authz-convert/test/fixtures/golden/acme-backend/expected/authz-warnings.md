# spinajs-authz-convert warnings

Inputs: test/fixtures/golden/acme-backend/config; layers: common, dev, local, prod.
The converter ran the config files, so a value a file computes (from process.env, the clock, …) is written as the value it had during the run. Check such keys by hand.

## Convert by hand (4)

The converter left these out (or wrote them as found) because it cannot convert them without guessing. Boot may fail until they are done.

- [common] `rbac.actions.create.afterCreate`: rbac.actions.create.afterCreate[0] is not plain data (a function or a class instance); the converter cannot write it. Move rbac.actions.create.afterCreate by hand. (not-data)
- [common] `rbac.accountTypes`: rbac.accountTypes is not a SpinaJS 2.x key; 3.0 reads no rbac.* key. Move it to a root of your own. (unknown-key)
- [common] `rbac.admin.roleGuard.service`: Role guard 'ScopedRoleGuard' was written as found, so boot fails until a 3.0 AdminGuard of that name is registered. Port it to AdminGuard (design §6.6); leaving it out would fall back to DefaultAdminGuard, which may allow more. (custom-service)
- [common] `rbac.token.rolePolicy.service`: Token role policy 'GrantSubsetTokenRolePolicy' was written as found; boot fails until a 3.0 policy of that name is registered. 3.0 ports no grant-subset rule: a token's roles are the token's roles that its owner holds (B24, B07). (custom-service)

## Behaviour changes and actions (23)

Converted, but 3.0 behaves differently here, or the app must act.

- [common] `rbac.grants["users.self"].user["read:own"]`: :own on 'user' became relation 'self' (the caller's own account). If the app registered a default OrmPermission policy for 'user', 2.x used it here and 'self' ignores it; pass --self-resources without 'user' to get relation 'owner' instead. (self-relation)
- [common] `rbac.grants["users.self"].user["update:own"]`: :own on 'user' became relation 'self' (the caller's own account). If the app registered a default OrmPermission policy for 'user', 2.x used it here and 'self' ignores it; pass --self-resources without 'user' to get relation 'owner' instead. (self-relation)
- [common] `rbac.roles[0]`: Role 'Stock editor' is declared but has no grants; it was written with no grants so it can be assigned. In 2.x a user holding it with other roles got no permission at all (accesscontrol refused the role list); in 3.0 the other roles apply. (declared-without-grants)
- [common] `authn.mfa.encryptionKey`: TOTP secrets are stored encrypted in 3.0: set authn.mfa.encryptionKey (a secret reference) before running the migrations, which refuse to run without it. (mfa-key)
- [local] test/fixtures/golden/acme-backend/config/twoFactorAuth.local.js reads process.env, so the values it gave this run were converted as constants; check the keys it sets. (reads-env)
- [common] `Task`: :own grants on Task became relation 'owner', but no @OrmResource('Task') model was found; a RelationResolver for 'owner' on type 'Task' must exist in 3.0. (owner-relation)
- [common] `TaskView`: :own grants on TaskView became relation 'owner', but no @OrmResource('TaskView') model was found; a RelationResolver for 'owner' on type 'TaskView' must exist in 3.0. (owner-relation)
- [common] `CampaignView`: :own grants on CampaignView became relation 'owner', but no @OrmResource('CampaignView') model was found; a RelationResolver for 'owner' on type 'CampaignView' must exist in 3.0. (owner-relation)
- [common] `CampaignComments`: :own grants on CampaignComments became relation 'owner', but no @OrmResource('CampaignComments') model was found; a RelationResolver for 'owner' on type 'CampaignComments' must exist in 3.0. (owner-relation)
- [common] `Client`: :own grants on Client became relation 'owner', but no @OrmResource('Client') model was found; a RelationResolver for 'owner' on type 'Client' must exist in 3.0. (owner-relation)
- [common] `users`: :own grants on users became relation 'owner', but its model (UserModel.js) has no @ResourceOwner(): port its default-scope @OrmPermission policy to @OrmScope(Model, 'owner'), or add @Owner(). (owner-relation)
- [common] `Localisation`: :own grants on Localisation became relation 'owner', but no @OrmResource('Localisation') model was found; a RelationResolver for 'owner' on type 'Localisation' must exist in 3.0. (owner-relation)
- [common] 2 user(s) hold several roles. 3.0 gives each the union of all their roles' grants unless the session switches to one role (H1, ceiling.roles); check that the union is meant: bob (acme.salesman, partner.backoffice); cid (user, Stock editor) (roles-together)
- [common] 1 user(s) or token(s) hold a role rbac.grants does not define next to other roles. 2.x gave them no permission at all; 3.0 ignores that role and applies the others: cid (user, Stock editor) (roles-voided)
- [common] 1 user(s) or token(s) hold role 'Admin', which matches 'admin' only in case; 3.0 ignores the assignment (with a warning) after the users.Role copy. (held-unknown-role)
- [common] 1 API token(s) have no expiry; the 3.0 migration gives them CreatedAt + authn.token.maxTtlDays (default 90 days). Tell their owners: 1 (token-no-expiry)
- [common] `http.trustProxy`: http.trustProxy is not set. Behind a proxy, set it to the hop count or the proxy CIDRs, or every client shares the proxy address for throttling and audit. (trust-proxy)
- [common] `http.cookie.secret`: http.cookie.secret is written in a config file, so everyone with the code has it. Rotate it and load it through a secret reference (env or a secret store). (cookie-secret)
- [common] `rbac.session.cookie`: The session cookie becomes '__Host-ssid' outside development and test (authn.session.cookie.hostPrefix 'auto'). Every 2.x session is logged out at the upgrade, and clients that send 'ssid' by name must change. (cookie-rename)
- [common] `rbac.password.expiration`: 2.x @spinajs/rbac expired passwords after 31 days unless the app turned it off; 3.0 never expires them unless authn.local.expiration.enabled is true. Set it (and maxAgeDays) if the app relied on the 2.x default. (password-expiry-default)
- [common] `rbac.password.blockAfterAttempts`: 2.x locked an account for 15 minutes after 5 failed logins (3 with @spinajs/rbac-http-user); 3.0 never locks and backs off instead, by default to at most 60 s per attempt (H31, A06). Tune authn.throttle.login if that is too weak. (lockout-default)
- [common] `rbac.defaultRole`: 2.x gave new users the role 'guest' by default. Nothing was written, and no 3.0 package lists authz.rbac.defaultRoles, so new users get no role; set it if the app relied on 'guest'. (default-role-default)
- [prod] `http.cors.origins`: http.cors.origins is empty: 2.x answered every origin, with credentials; 3.0 allows no cross-origin request (H33, A31). List every origin a browser client uses (and in authn.http.csrf.allowedOrigins for cookie sessions). (cors-empty)

## Notes (10)

Converted as the migration guide describes.

- [common] `rbac.grants.system.$extend`: 2.x joined this $extend with the package's ["admin"]; only the app's part was written, and the 3.0 packages define their own 'system'. (package-extends)
- [common] `rbac.grants.admin.$extend`: 2.x joined this $extend with the package's ["admin.users"]; only the app's part was written, and the 3.0 packages define their own 'admin'. (package-extends)
- [common] No user or token holds 'admin.campaigns', 'users.self', 'location.subscriptions', 'route.home', 'route.salesman', 'route.user', 'route.admin', 'route.campaigns' and other roles extend them, so they are written 'assignable: false'. (assignable)
- [common] `CampaignView`: 'scope:partner' on CampaignView became relation 'partner': port @OrmPermission(Model, 'partner') policies to @OrmScope(Model, 'partner') (OrmScopePolicy). (scope-relation)
- [common] `Campaign`: :own grants on Campaign became relation 'owner'; its model has @ResourceOwner(), which becomes @Owner(). (owner-relation)
- [common] `Campaign`: 'scope:partner' on Campaign became relation 'partner': port @OrmPermission(Model, 'partner') policies to @OrmScope(Model, 'partner') (OrmScopePolicy). (scope-relation)
- [common] `user`: :own grants on user became relation 'self' (the caller's own account); a RelationResolver for 'self' on type 'user' must exist in 3.0. (relation-self)
- [common] `LocationSubscription`: :own grants on LocationSubscription became relation 'owner'; its model has @ResourceOwner(), which becomes @Owner(). (owner-relation)
- [common] `rbac.auth.service`: 2.x logged users in with @spinajs/rbac's SimpleDbAuthProvider by default; authn.strategies lists the local password strategy. (auth-default)
- [common] `rbac.enableGuestAccount`: 2.x had no guest account by default. 3.0 turns the anonymous principal on, with the roles of authz.rbac.anonymousRoles; set authz.principals.anonymous.enabled: false to match 2.x exactly. (guest-default)
