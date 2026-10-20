# Config key mapping

`convertKeys()` turns every `rbac.*` key except `grants` and `roles` into keys of the `authz.*`, `authn.*` and `users.*` roots. This page lists what the converter writes for each 2.x key; what the 3.0 keys do is in the docs of the package that owns them.

`rbac.grants` and `rbac.roles` are on [Grant and role conversion](04-grant-and-role-conversion.md).

## How it works

1. `convertLayers()` calls `convertKeys(layer, merged, findings, common)` once per layer. `layer` is the layer's own files, `merged` is the view it sits in (common, or common plus the env).
2. Each `rbac.*` key of the layer is converted on its own. A key built from several 2.x keys (the privileged permission, the MFA step) reads the other parts from `merged`, falling back to the 2.x package defaults in `RBAC_2X_DEFAULTS`.
3. A value of the wrong type is refused. An unknown key, or an unknown sub-key of a known block, becomes a manual `unknown-key` item.
4. Values copied as a subtree (`rbac.user`, `rbac.session`, ...) keep plain data only. A function or class instance is left out and listed as a manual `not-data` item; the rest of the subtree is written.

## Authorization keys (`authz.*`)

| 2.x key | 3.0 key | Conversion |
| --- | --- | --- |
| `rbac.enableGuestAccount` | `authz.principals.anonymous.enabled` | Same boolean. When `true`, also `authz.rbac.anonymousRoles: ['guest']`: the 2.x guest account always held `guest`. |
| `rbac.defaultRole` | `authz.rbac.defaultRoles` | `[role]`. |
| `rbac.roleColumn` | `authz.rbac.migration.roleColumn` | Copied; the `users.Role` copy migration reads it. |
| `rbac.roleSwitch.requirePassword` | `authz.principals.roleSwitch.requirePassword` | Copied (array of role names). |
| `rbac.impersonation.protectedRoles` | `authz.impersonation.protectedRoles` | The app's roles plus the 2.x package part `['system']` (`package-array` note), in the common layer, or in an env layer when common does not set the key. |
| `rbac.admin.roleGuard.service` | `authz.admin.guard.service` | `DefaultRoleGuard` becomes `DefaultAdminGuard`. Any other name is written as found, plus a manual `custom-service` item: boot fails until a 3.0 `AdminGuard` of that name is registered. |
| `rbac.admin.roleGuard.protectSystemRole`, `.preventEscalation`, `.preventSelfLockout`, `.preventLastPrivilegedRemoval` | `authz.admin.guard.<same name>` | Same boolean. |
| `rbac.admin.roleGuard.privilegedResource`, `.privilegedAction` | `authz.admin.guard.privilegedPermission` | `<resource>:<verb>`, where `verb` comes from `create`, `read`, `update` or `delete` with an optional `:any`. Written only when the layer sets one of the two; an unset half comes from the merged view, else the 2.x default `users` or `update:any`. An `:own` action names no single permission: manual `privileged-permission` item. |
| `rbac.token.rolePolicy` | `authz.token.rolePolicy` | `{ service }` copied. A service other than `OwnRolesTokenRolePolicy` is a manual `custom-service` item; another shape is a manual `token-role-policy` item. |
| `rbac.token.excludedRoles` | `authz.token.excludedRoles` | Copied. |

When the converter writes any `authz.admin.guard` key but no `privilegedPermission`, it adds a manual `guard-privileged-permission` item: boot requires that key unless both `preventSelfLockout` and `preventLastPrivilegedRemoval` are `false`.

## Authentication keys (`authn.*`)

| 2.x key | 3.0 key | Conversion |
| --- | --- | --- |
| `rbac.auth.service` | `authn.strategies` | `SimpleDbAuthProvider` becomes `[{ name: 'local', service: 'LocalPasswordStrategy' }]`. Unset, the same entry is written (the 2.x default; see [Arrays across layers](02-config-loading-and-env-layers.md#arrays-across-layers)). Any other provider is a manual `custom-service` item. |
| `rbac.password.service` | `authn.local.hasher.service` | `BasicPasswordProvider` becomes `Argon2PasswordHasher`. Any other provider is a manual `custom-service` item. |
| `rbac.password.generator` | `authn.local.generator` | Copied. `characters` gets the 2.x package character sets (`a-z`, `A-Z`, `0-9`) added, under the same rule as `protectedRoles`. |
| `rbac.password.validation.rule` | `authn.local.policy.rule` | Copied. |
| `rbac.password.validation.description` | `authn.local.policy.description` | Copied. |
| `rbac.password.validation.service` | none | A service other than `BasicPasswordValidationProvider` is a manual `custom-service` item. |
| `rbac.password.expiration.enabled` | `authn.local.expiration.enabled` | Same boolean. |
| `rbac.password.expiration.passwordExpirationTime` | `authn.local.expiration.maxAgeDays` | Seconds divided by 86400. Not a whole number of days: manual `expiration-days` item. |
| `rbac.password.passwordResetWaitTime` | `authn.local.reset.ttlSeconds` | Copied (positive whole seconds). |
| `rbac.password.invite.waitTime` | `authn.local.invite.ttlSeconds` | Copied (positive whole seconds). |
| `rbac.password.resetUrl` | `authn.local.reset.url` | Copied. |
| `rbac.password.blockAfterAttempts` | `authn.throttle.login.account` | `n > 0`: `{ free: n, baseDelayMs: 1000, maxDelayMs: 60000 }` and a `lockout-to-backoff` warning: 3.0 backs off and never locks. `0`: nothing written, `throttle-off` warning. |
| `rbac.password.lockoutTime` | none | Dropped, `lockout-time` warning. The nearest knob is `authn.throttle.login.account.maxDelayMs`. |
| `rbac.session` | `authn.session` | Copied with the same sub-paths. |
| `rbac.twoFactorAuth.forceUser` | `authn.mfa.policy.force` | Same boolean. |
| `rbac.twoFactorAuth.enabled`, `.service` | `authn.mfa.steps` | On with `Default2FaToken` (the 2.x defaults when unset): `[{ name: 'totp', service: 'TotpMfaStep' }]` and an `mfa-key` warning to set `authn.mfa.encryptionKey`. Off: no step (`mfa-off` note), and a manual item when `forceUser` is on. Another service: manual `custom-service` item. |
| `rbac.otpauth` | `authn.mfa.totp` | Copied. |
| `rbac.token.prefix`, `.headerName` | `authn.token.prefix`, `authn.token.headerName` | Copied (non-empty strings). |
| `rbac.token.length` | `authn.token.length` | Copied. Below 32: manual `token-length` item, as 3.0 fails boot on it. |
| `rbac.token.lastUsedUpdateInterval` | `authn.token.lastUsedUpdateInterval` | Copied (whole seconds, 0 or more). |
| `rbac.token.generation` | `authn.token.generation` | Copied. |
| `rbac.impersonation.requirePassword` | `authn.impersonation.requirePassword` | Same boolean. |

## Identity keys (`users.*`)

| 2.x key | 3.0 key | Conversion |
| --- | --- | --- |
| `rbac.user` | `users.user` | Copied with the same sub-paths. |
| `rbac.email` | `users.email` | Copied with the same sub-paths. |
| `rbac.actions` | `users.actions` | Copied. Hooks written as functions are left out as manual `not-data` items. |

## Removed keys

| 2.x key | Conversion |
| --- | --- |
| `rbac.requireKnownRole` | Dropped. `false` gives a `require-known-role` warning: 3.0 always refuses an unknown role on an assignment write. |
| `rbac.systemRole` | Dropped. A value other than `system` gives a `system-role` warning: 3.0 has no system role, `SYSTEM` is a principal. |
| `rbac.admin.roleGuard.requireKnownRole` | Dropped, `removed` note: `AuthzAdmin` always refuses unknown roles. |
| Any other `rbac.*` key | Manual `unknown-key` item. 3.0 fails boot on any `rbac.*` key unless `authz.config.rejectLegacyKeys` is `false`. |

## 2.x package defaults

The converter reads only the app's files, so it carries the values the 2.x packages added itself. They are exported as constants:

| Constant | Holds | Used for |
| --- | --- | --- |
| `RBAC_2X_DEFAULTS` | Scalar defaults by path under `rbac` (`auth.service`, `twoFactorAuth.enabled`, `admin.roleGuard.privilegedAction`, ...) | Keys built from several 2.x keys, and the package-default findings. |
| `RBAC_2X_ARRAYS` | `impersonation.protectedRoles` and `password.generator.characters` | Arrays 2.x joined with the app's array. |
| `RBAC_2X_PACKAGE_GRANTS` | Role, resource and action key to the attribute list the packages granted | Refusing or noting app grants on the same key. |
| `RBAC_2X_PACKAGE_EXTENDS` | `system` extends `admin`, `admin` extends `admin.users` | The `package-extends` note. |
| `RBAC_2X_PACKAGE_ROLES` | `guest`, `system`, `admin.users`, `user`, `admin` | Roles 2.x knew in every app (`roles-voided` check). |
| `HTTP_2X_COOKIE_SECRET` | The public `@spinajs/http` 2.x cookie secret | The `cookie-secret` warning. |

Where the app relied on a package default by leaving a key out, `analyze()` lists the 3.0 difference instead of writing a key, except for the login strategy. See [Findings and refusals](05-findings-and-refusals.md#package-defaults).

## Important behaviour

- Booleans must be `true` or `false`, durations positive whole seconds, role lists arrays of strings. Strings like `'true'` are refused, not coerced.
- `rbac.impersonation` is split: who may be impersonated goes to `authz`, how the impersonator re-authenticates goes to `authn`.
- `rbac.token` is split the same way: role policy and excluded roles to `authz.token`, token format and lifetime to `authn.token`.
- A key written in common and repeated with the same value in an env file is written in both files, except for the [array keys](02-config-loading-and-env-layers.md#arrays-across-layers).

## Related

- [Migration guide, section 3](../authz/migration-guide.md#3-config): the same mapping with the 3.0 behaviour behind each key.
- [`@spinajs/authz` config](../authz/04-host-boot-and-configuration.md#configuration): the `authz.*` keys.
- [`@spinajs/authn` config](../authn/13-configuration-and-boot-checks.md): the `authn.*` keys.
- [`@spinajs/users`](../users/README.md): the `users.*` keys.
