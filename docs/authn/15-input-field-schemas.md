# Input field schemas

`@spinajs/authn` holds the JSON-schema fields every authn package validates its input against: the DTOs of the HTTP routes embed them, and the services that can be called outside a controller check the same fields again. One definition per field keeps the caps in step.

## How it works

- `@spinajs/authn/schemas` (also the package root) exports the field fragments, `bodyOf`, `fieldSchema`, `AUTHN_FIELD_SCHEMAS` and `isValidField`.
- A fragment has no `$id`, so it can appear several times in one schema (`password` and `confirmPassword`). ajv refuses one `$id` twice.
- `bodyOf(required, properties, id)` builds a closed object schema: `type: 'object'`, `additionalProperties: false`, the `required` list and the `properties`, with `$id` = `id`. The id must start with `authn.`, which `@spinajs/validation` validates without type coercion.
- `fieldSchema(id, field)` turns one fragment into a schema of its own with an `authn.` `$id`. `AUTHN_FIELD_SCHEMAS` holds one per fragment (`authn.field.login`, `authn.field.tokenId`, ...).
- `isValidField(schema, value)` checks one value with a module-local ajv: no coercion, no defaults, no container. Services use it, so they work in tests and CLI commands without a `DataValidator`.

## Fields

| Fragment | Shape |
| --- | --- |
| `loginField`, `passwordField`, `secretField`, `codeField`, `reauthPasswordField`, `tokenSecretField` | string, 1 to `PASSWORD_HARD_CAP` (1024) characters |
| `tokenIdField` | string, 1 to 64 |
| `sessionHandleField` | string, 1 to 128 |
| `mfaStepField` | string, 1 to 64 |
| `mfaResponseField` | string, 1 to 65536 |
| `oidcSubjectField` | string, 1 to 255 |
| `oidcGroupField` | string, at most 255 |
| `oidcGroupsField` | array of at most 256 `oidcGroupField` |
| `kidField` | `^[A-Za-z0-9._-]{1,64}$` |
| `isoInstantField` | RFC 3339 date-time, at most 40 characters |
| `identityRefField` | a string id of 1 to 256 characters, or `{ type (1..64), id (1..256) }` |

## Services that check their input again

Each refuses in the way it already answers a bad input, so no answer changes shape:

| Function | Check | Answer |
| --- | --- | --- |
| `LocalPasswordService.requestReset`, `requestCode` | `loginField` | `{ status: 'accepted' }`, with no throttle key, lookup or mail |
| `LocalPasswordService.redeemVerification` | `secretField` | `{ status: 'invalid' }`, audited `malformed` |
| `LocalPasswordStrategy.verify`, `EmailCodeStrategy.verify` | `loginField` | `invalid_credentials` after the same dummy work |
| `DbTokenService.validate` | `tokenSecretField` | `invalid_credentials` |
| `DbTokenService.revoke`, `revokeById` | `tokenIdField` | `false` |
| `DefaultSessionIssuer.revokeHandle` | `sessionHandleField` | `false`, without reading the store |
| `DefaultAuthnService.completeMfa`, `stepUp` | `mfaStepField`, `mfaResponseField` | `invalid_credentials`, counted in the `mfa` throttle, audited `mfa.verify` `malformed` |
| OIDC `mapClaims` (groups) | `oidcGroupField`, `oidcGroupsField` | longer groups dropped; more than 256 leave `groups` absent |

## Example

```ts
import { bodyOf, loginField, passwordField, isValidField } from '@spinajs/authn/schemas';

export const LOGIN_BODY = bodyOf(['login', 'password'], { login: loginField, password: passwordField }, 'authn.LoginBody');

isValidField(LOGIN_BODY, { login: 'alice', password: 'secret' }); // true
isValidField(LOGIN_BODY, { login: 'alice', password: 'secret', extra: 1 }); // false: unknown key
isValidField(loginField, 123); // false: no coercion
```

## Related

- [Authorization field schemas](../authz/16-input-field-schemas.md)
- [Authentication flow](01-authentication-flow.md#results-and-failure-reasons)
