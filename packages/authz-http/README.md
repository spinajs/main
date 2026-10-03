# `@spinajs/authz-http`

HTTP integration for SpinaJS authorization.

## Field filters

On an `@Access` route the body args are limited to what the route's decision lets the caller write
(`decision.fields.write` minus `authz.fields.neverRead`): stripped by default, a 400 naming the fields
in `reject` mode (`authz.fields.write.mode`). `@Access(…, { fields: 'filter' })` limits the response to
`decision.fields.read` the same way.

- A body arg holding a value, or a list that is not all records, is one field of the record and is
  checked by its parameter name: `@Body() roles: string[]` needs `roles` to be writable.
- An object, or a list of records, is a record and is checked against the root field globs. A named
  object param is therefore matched as a record, not as `<name>.*`: `@Body() settings: object` with
  `{ Name }` passes when `Name` is writable. This is by design, so that `neverRead` holds for record
  DTOs next to other body args. Give such a param its own DTO route, or check it in the action.
- Routes without `@Access` are not filtered. `@UnfilteredInput(reason)` opts a route out, e.g. an admin
  route that sets a password.
