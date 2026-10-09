# Release notes — validation errors without request values (Z4)

> X1 merges this file into the root `RELEASE_NOTES.md` for 3.0.

Why: a 400 or a log line built from a validation error must not carry what the client sent, so a
password, a token or a reset code never comes back in a response or lands in a log.

## BREAKING CHANGES

### `ValidationFailed`

| Removed | Use instead |
|---|---|
| `new ValidationFailed(message, errors, data, schema)` | `new ValidationFailed(message, errors, schema?)` |
| `ValidationFailed.data` | nothing: the exception keeps no value of the validated data |
| `IValidationErrorDetail.value` | `details[].field` (the JSON pointer) and `details[].params` |

- The `data` argument is gone. A JavaScript caller that still passes the old order stores `data` as the
  `schema` (which is not enumerable, so it is not serialised); the fourth argument is ignored.
- `parameter` holds sanitised copies of the AJV errors: `instancePath`, `schemaPath`, `keyword`, `params`,
  `message` and `propertyName` only. AJV's verbose `data`, `schema` and `parentSchema` are dropped.
- `schema` is not enumerable: neither a spread (`{ ...err }`) nor `JSON.stringify` carries it.
  `getExpectedSchema()` and `getFieldRequirements()` still read it.
- `toString()` prints no value, and of the schema only its `$id` (`inline schema` when it has none).

### `DataValidator`

- AJV runs with `verbose: true` whatever the `validation` configuration says. Sanitising needs
  `parentSchema` to tell `$data` rules apart; no error leaves the validator unsanitised, so callers never
  see verbose `data`. (`$data: true` was already forced.)
- `tryValidate` and `validateSchema` return sanitised errors, reduced to the fields `parameter` keeps.
- A rule written with `$data` (`confirm: { const: { $data: '1/password' } }`, a `maxLength` read from
  another field) reports `params: { $data: '<pointer>' }` and a message naming only the keyword and the
  pointer, since AJV builds both from the referenced field of the request.
- The `discriminator` error drops `params.tagValue`, which is the request's value.

## New

- `sanitizeError(error, schema?)` is exported: it reduces one AJV error the same way. Without verbose
  `parentSchema` it finds `$data` rules through `schema` and the error's local `schemaPath`; when that fails
  and `schema` uses `$data` anywhere, it drops the params and message of keywords that carry a rule value.
