---
"@spinajs/compiler": minor
"@spinajs/validation": minor
"@spinajs/manifest": patch
"@spinajs/http-socket": patch
"@spinajs/testing": patch
---

The compiler records the server-side type of a well-known schema in `x-spinajs-type`: `Date` and luxon `DateTime` give `{ type: 'string', format: 'date-time', 'x-spinajs-type': 'Date' | 'DateTime' }`, and `bigint` gives `{ type: 'string', pattern: '^-?[0-9]+$', 'x-spinajs-type': 'bigint' }`. A decimal.js `Decimal` or a big.js `Big` now derives to `{ type: 'string', format: 'decimal', 'x-spinajs-type': 'Decimal' }`, where it used to derive to the class's members. Ajv, OpenAPI, AsyncAPI and the generated client drop `x-*` keys, so their output does not change.

The app's own schemas without these types derive byte for byte as before. The manifest hash still changes on rebuild for nearly every app, because the shipped manifest fragments change:
- `@spinajs/authn-keys`, `authn-orm`, `authn-token`, `authn-webauthn`, `authz-abac`, `authz-http`, `authz-orm`, `authz-rbac`, `authz-rebac`, `configuration-db-source`, `email`, `orm-threading`, `queue`, `session-provider-db`, `tasks`, `teams`, `upload` and `users` gain the key on their `Date` and `DateTime` fields;
- the `@spinajs/http-socket` and `@spinajs/validation` fragments record shifted source lines.

In `manifest:diff`, each schema that gains the key shows once as "schema changed", and that change is not breaking. `@spinajs/manifest` now ignores `x-*` keys when it matches union members (`Date | number`). Before, such a member counted as removed and added, which `manifest:diff` reported as breaking, and the socket contract check raised `SOCK002`/`SOCK003` against a contract built before the key existed.

`@spinajs/validation` registers a new `decimal` format on `ManifestValidator` and on both `DataValidator` instances. It accepts plain decimal text matching `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`: `'12.50'` passes, `'1e3'` does not. Write it as `@format decimal` on a string property. `DECIMAL_PATTERN` and `addSpinajsFormats(ajv)` are exported. Two more validators register it:
- The `@spinajs/http-socket` contract validator. It compiles with `strictSchema`, so a contract payload with a `decimal` member used to fail the boot in `require` mode.
- The `@spinajs/testing` `manifestContractValidator`. It used to warn about an unknown format and accept any string.
