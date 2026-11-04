---
"@spinajs/compiler": minor
"@spinajs/validation": minor
"@spinajs/http-socket": patch
---

The compiler records the server-side type of a well-known schema in `x-spinajs-type`: `Date` and luxon `DateTime` give `{ type: 'string', format: 'date-time', 'x-spinajs-type': 'Date' | 'DateTime' }`, and `bigint` gives `{ type: 'string', pattern: '^-?[0-9]+$', 'x-spinajs-type': 'bigint' }`. A decimal.js `Decimal` or a big.js `Big` now derives to `{ type: 'string', format: 'decimal', 'x-spinajs-type': 'Decimal' }`, where it used to derive to the class's members. Ajv, OpenAPI, AsyncAPI and the generated client drop `x-*` keys, so their output does not change. A manifest with none of these types keeps its hash. A rebuilt manifest that has them shows each affected schema once in `manifest:diff`, as a non-breaking "schema changed". The shipped manifest fragments of `@spinajs/authn-keys`, `authn-orm`, `authn-token`, `authn-webauthn`, `authz-abac`, `authz-http`, `authz-orm`, `authz-rbac`, `authz-rebac`, `configuration-db-source`, `email`, `orm-threading`, `queue`, `session-provider-db`, `tasks`, `teams`, `upload` and `users` gain the key on their `Date` and `DateTime` fields, so an app that depends on one of them gets a new manifest hash when it rebuilds its manifest.

`@spinajs/validation` registers a new `decimal` format on `ManifestValidator` and on both `DataValidator` instances: plain decimal text matching `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$` (`'12.50'` passes, `'1e3'` does not). Write it as `@format decimal` on a string property. `DECIMAL_PATTERN` and `addSpinajsFormats(ajv)` are exported. The `@spinajs/http-socket` contract validator registers it too: it compiles with `strictSchema`, so a contract payload with a `decimal` member used to fail the boot in `require` mode.
