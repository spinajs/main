# Findings and refusals

The converter never guesses. What it cannot convert exactly either stops the run (a refusal) or is written into `authz-warnings.md` as a finding for a person to act on.

## How it works

1. Every conversion step reports into a `Findings` object of its layer: `refuse(problem)`, `manual()`, `warn()` or `info()`.
2. After all layers are converted, `convertLayers()` collects the refusals of every layer. If there is one, it throws `ConversionError` and returns no file.
3. Otherwise it adds the findings about the whole run (skipped files, computed values, env readers, failed probe runs, the MFA key, `assignable` roles).
4. `analyze()` checks the common view and each env view for 2.x behaviour the conversion changes, and for data and secrets the app must handle. Its findings never change the output files. A finding already listed for common is not repeated for an env.
5. `warningsMarkdown()` renders all findings into `authz-warnings.md`, one section per severity.
6. `exitCode` is `2` when any finding is `manual`, else `0`.

## Severities

| Severity | Section in `authz-warnings.md` | Meaning |
| --- | --- | --- |
| `manual` | Convert by hand | Left out, or written as found, because converting it needs a guess. Boot may fail until it is done. Gives exit code `2`. |
| `warning` | Behaviour changes and actions | Converted, but 3.0 behaves differently, or the app must act (secrets, models, data). |
| `info` | Notes | Converted as documented; listed so the review sees it. |

Each line reads `- [<layer>] \`<2.x path>\`: <message> (<code>)`. The layer is `common` or an env suffix.

```md
## Convert by hand (2)

The converter left these out (or wrote them as found) because it cannot convert them without guessing. Boot may fail until they are done.

- [common] `rbac.actions.create.afterCreate`: rbac.actions.create.afterCreate[0] is not plain data (a function or a class instance); the converter cannot write it. Move rbac.actions.create.afterCreate by hand. (not-data)
- [common] `rbac.accountTypes`: rbac.accountTypes is not a SpinaJS 2.x key; 3.0 drops the rbac.* root. Move it to a root of your own. (unknown-key)
```

## What the converter refuses

A refusal ends the run with exit code `1` and no file. `ConversionError.problems` lists every problem of every layer, each prefixed with `[<layer>]` when it belongs to one.

| Area | Refused when |
| --- | --- |
| Input | No config dir; a dir that is missing, holds TypeScript sources or holds no `.js`, `.cjs` or `.json` file; a file that fails to load; a file the configuration loader did not read. |
| Layers | A key set by an env JS file and a common JSON file; an attribute list set in common and in an env file. |
| Grants | See [Grant and role conversion](04-grant-and-role-conversion.md#refusals): invalid role and resource names, action keys `accesscontrol` rejects, `scope:` on `:any`, `scope:owner` and `scope:self`, non-glob attributes, attributes with spaces, scope tokens with negated fields only, negations or scope tokens on a key a 2.x package also granted. |
| Values | A value of the wrong type: a block that is not an object, a non-boolean switch, a duration that is not a positive whole number of seconds, a role list that is not an array of strings, an empty string where a name is needed. |
| CLI | An unknown option, an option without a value, an unreadable or malformed `--db` file, a missing `--src` dir, output files that exist without `--force`. |

## Finding codes

### Convert by hand (`manual`)

| Code | Raised when |
| --- | --- |
| `unknown-key` | An `rbac.*` key, or a sub-key of a known block, that is not a 2.x key. |
| `not-data` | A value a file cannot hold (function, class instance, `NaN`). |
| `custom-service` | A custom auth, password, validation or 2FA provider (left out), or a custom role guard or token role policy (written as found). |
| `privileged-permission` | `privilegedResource` and `privilegedAction` name no single 3.0 permission. |
| `guard-privileged-permission` | An admin guard was written without `privilegedPermission`, which boot requires. |
| `token-role-policy` | `rbac.token.rolePolicy` is not `{ service }`. |
| `token-length` | `rbac.token.length` is below 32. |
| `expiration-days` | `passwordExpirationTime` is not a whole number of days. |
| `mfa-force-without-steps` | `forceUser` is on while two-factor login is off. |
| `mfa-default` | `rbac.twoFactorAuth` is unset: 2.x `rbac-http-user` turned TOTP on by default, 3.0 ships no step. |
| `env-array` | An env file would need to replace or empty an [array key](02-config-loading-and-env-layers.md#arrays-across-layers) set in common, or logs in with another provider than common. |
| `computed-value` | An `rbac.*` or `http.*` value changed under another `NODE_ENV`. |
| `probe-failed` | A run under another `NODE_ENV` failed. |
| `action-never-read` | An action key 2.x accepted but never looked up. |
| `impersonate-action` | An action other than `create:any` on `user:impersonate`. |
| `role-name` | A role name that is not a valid 3.0 role name. |

### Behaviour changes and actions (`warning`)

| Code | Raised when |
| --- | --- |
| `lockout-to-backoff`, `throttle-off`, `lockout-time` | `blockAfterAttempts` or `lockoutTime` set: 3.0 backs off and never locks. |
| `require-known-role`, `system-role` | `requireKnownRole: false`, or a `systemRole` other than `system`. |
| `mfa-key` | A TOTP step was written: set `authn.mfa.encryptionKey` (a secret reference). Outside development and test, boot refuses to start without it while a listed step stores secrets. |
| `file-skipped` | A dot file, or an env file named `production` or `development`. |
| `reads-env` | A config file reads environment variables. |
| `self-relation`, `own-any-fields` | See [Grant and role conversion](04-grant-and-role-conversion.md#grant-rules). |
| `role-case`, `resource-case` | Role or resource names that differ only in case. |
| `declared-without-grants` | A role in `rbac.roles` with no grants. |
| `absorbed-scope` | 2.x merged a `scope:x` with a `*` from an extended role and ran only the owner policy; 3.0 keeps relation `x`, so the role reaches more rows. |
| `default-role` | `rbac.defaultRole` is not defined in the config files. |
| `owner-relation` | An `:own` grant became relation `owner`; the model needs `@Owner()` (no `--src`, no model found, or no `@ResourceOwner()`). |
| `scope-relation` | With `--src`, no `@OrmPermission` policy of that scope was found. |
| `roles-together`, `roles-voided`, `held-unknown-role`, `token-no-expiry` | `--db` rows: users with several roles, role lists 2.x voided, held roles no config defines (or that match a defined role only in case), tokens without expiry. No 2.x token survives the upgrade, so `token-no-expiry` names the owners to tell. |
| `trust-proxy` | Neither `http.trustProxy` nor `authn.http.trustProxy` is set. |
| `cors-empty` | `http.cors.origins` is an empty list: 2.x answered every origin, 3.0 none. |
| `cookie-secret` | `http.cookie.secret` is unset, the public 2.x default, or written in a config file instead of a secret reference. |
| `cookie-rename`, `cookie-secure` | The session cookie gets the `__Host-` name; `secure: false` no longer relaxes it. |
| `password-expiry-default`, `lockout-default`, `default-role-default`, `guest-role-missing` | See [Package defaults](#package-defaults). |

### Notes (`info`)

| Code | Raised when |
| --- | --- |
| `guest-role`, `removed`, `package-array`, `mfa-off` | A key converted with a documented change. |
| `grants-nothing`, `own-under-any`, `delete-fields` | A grant 2.x did not give, or a part with no 3.0 effect. |
| `package-grant`, `package-extends` | An app grant or `$extend` on a key the 2.x packages also set. |
| `assignable` | Roles written `assignable: false` (with `--db`), or the candidates (without it). |
| `extends-outside` | Roles extended but defined in no config file; a 3.0 package fragment must define them. |
| `relation-self`, `owner-relation`, `scope-relation` | Relations the app must support; `owner-relation` is a note when the model has `@ResourceOwner()`. |
| `auth-default`, `guest-default` | `rbac.auth` or `rbac.enableGuestAccount` left out; see [Package defaults](#package-defaults). |

## Package defaults

The converter reads only the app's own files. Where the app left a key out and ran on a 2.x package default, `analyze()` lists the 3.0 difference:

| Key left out | Finding | 3.0 difference |
| --- | --- | --- |
| `rbac.password.expiration.enabled` | `password-expiry-default` (warning) | 2.x expired passwords after 31 days; 3.0 never does unless `authn.local.expiration.enabled` is `true`. |
| `rbac.twoFactorAuth` | `mfa-default` (manual) | 2.x `rbac-http-user` turned TOTP on; 3.0 has no step unless `authn.mfa.steps` lists one. |
| `rbac.password.blockAfterAttempts` | `lockout-default` (warning) | 2.x locked for 15 minutes after 5 failures; 3.0 backs off. |
| `rbac.auth.service` | `auth-default` (note) | The local strategy is written (see [Config key mapping](03-config-key-mapping.md#authentication-keys-authn)). |
| `rbac.defaultRole` | `default-role-default` (warning) | 2.x gave new users `guest`; nothing is written, so new users get no role. |
| `rbac.enableGuestAccount` | `guest-default` (note) | 3.0 turns the anonymous principal on; set `authz.principals.anonymous.enabled: false` to match 2.x. |
| `rbac.enableGuestAccount: true` without a `guest` role | `guest-role-missing` (warning) | 3.0 refuses the unknown role at boot unless a package fragment defines it. |

These checks run only when the view holds `rbac` keys. The [migration guide](../authz/migration-guide.md#33-where-the-2x-package-defaults-went) explains each 3.0 default.

## Best practices

- Work through "Convert by hand" first: those items fail the boot or leave access unconverted.
- Read every `owner-relation` and `scope-relation` line with the model sources open; they decide which rows a role reaches in 3.0.
- Re-run the converter after each fix in the 2.x config; it overwrites only with `--force`.
- Keep `authz-warnings.md` with the migration change for review.

## Examples

### Fail a build on open manual items

```ts sample
import { convert } from '@spinajs/authz-convert';

export async function assertConverted(): Promise<void> {
  const { findings } = await convert({ dirs: ['lib/mjs/config'] });
  const open = findings.filter((f) => f.severity === 'manual');
  for (const f of open) console.error(`[${f.layer ?? 'common'}] ${f.path ?? ''} ${f.code}: ${f.message}`);
  if (open.length > 0) throw new Error(`${open.length} key(s) still need converting by hand`);
}
```

## Related

- [Migration guide, section 4.3](../authz/migration-guide.md#43-read-authz-warningsmd): what to do with each section.
- [Running the converter](01-running-the-converter.md#exit-codes): how findings set the exit code.
