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

## Client access API

Generic, not tied to any UI kit (design §10). ckit's `createHttpChecker` talks to it with its defaults.

### `POST /user/access/checks`

```
{ "checks": [ { "object": { "type": "invoice", "id": "42" }, "permission": "edit",
                "subject"?: { "type": "user", "id": "…" },
                "context"?: { "field"?: "amount", "fieldMode"?: "read" | "write" } } ] }
→ 200 { "results": [true], "reasons": [null] }
```

- A permission with `:` is used as is; otherwise it becomes `<object.type>:<permission>`.
- `id: '*'` checks the type (`{ type }`, e.g. "may I create"); `type: '$global'` checks `GLOBAL`.
- `true` only for a definite allow (allowed with a `TRUE` residual after the row is loaded). Everything
  else is `false` with a reason: the decision's deny code (`invalid_request` for an unknown permission or
  type), or `invalid_request` (malformed entry), `subject_mismatch`, `conditional`, `field_denied`. A bad
  entry never fails the batch.
- `subject` may only name the caller; the subject is always the request's principal.
- `context.field` narrows the answer to `decision.fields[fieldMode]` (default `write`); no other context
  key is read, and none reaches `env`.
- Any principal, anonymous included; 401 without one. At most 100 entries (400 above, or for a body
  that is not a list).

### `X-Access-Epoch`

Every response with a principal carries `X-Access-Epoch`. It changes on login, role switch, MFA
elevation, impersonation start and end, and a token or link ceiling change. Drop cached answers when it
changes. Cross-origin clients need it in `http.cors.exposedHeaders`.

### `GET /user/access/events`

Server-sent events for the caller: `event: authz.changed` with `data: { "objects"?: [{ type, id }] }`.
`objects` is present only when exact; without it, refetch everything. A heartbeat comment every 25 s;
`retry: 5000`. The stream is uncompressed (`Cache-Control: no-transform`) and tells nginx not to buffer
(`X-Accel-Buffering: no`). The transport (`SseAccessPushTransport`) is fed by the root domain's
`AccessChangeRouter`. Push is per node: each node pushes to its own streams. With several nodes, set
`authz.bus.service: 'QueueChangeBus'` (`@spinajs/authz-queue`) so every node sees every change; with the
in-process bus only clients connected to the node that made the change are told.

### Explain tree

`GET /authz/explain?…&format=tree` (never in production) answers `{ label, allowed, children }`: the
decision, one node per model vote with its trace steps, then the engine's steps.
