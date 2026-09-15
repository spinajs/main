# `@spinajs/configuration-http`

HTTP API for reading and updating database-stored configuration values managed by
[`@spinajs/configuration-db-source`](../configuration-db-source).

It exposes a read + update CRUD surface over the `configuration` table. Entries
themselves are created by code that exposes config options (`expose: true`), so
this API intentionally does **not** create or delete arbitrary entries — it only
lets operators tune existing values.

## Endpoints

| Method | Path                     | Permission  | Description                                  |
| ------ | ------------------------ | ----------- | -------------------------------------------- |
| GET    | `/configuration`         | `readAny`   | List all entries (optional `?group=` filter) |
| GET    | `/configuration/:slug`   | `readAny`   | Get a single entry by slug                   |
| PATCH  | `/configuration/:slug`   | `updateAny` | Update an entry's `Value` (+ `Default`/`Watch`) |

All routes require a valid session (`AuthorizedPolicy`) and are guarded by
`RbacPolicy` on the `configuration` resource.

Incoming values are validated against the entry `Type` and `Meta` constraints
(min/max, oneOf/manyOf, date bounds) and stored in their canonical string form.

## Value schemas

An entry can carry its own JSON schema. Register a schema in
[`@spinajs/validation`](../validation) whose `$id` equals the config path passed
to `@Config(path, { expose: true, ... })`, e.g. a file in `system.dirs.schemas`:

```json
{
  "$id": "legacy.v1.reports.financial_full",
  "type": "string",
  "pattern": "\\.xlsx$"
}
```

`PATCH /configuration/:slug` then validates `Value` and `Default` against the
entry `Type` / `Meta` **and** that schema. The schema describes the JSON value as
sent to the API (an ISO string for `date`, an array for `manyOf`, an object for
`json`), not the typed runtime value. Entries without a registered schema are
validated by `Type` / `Meta` only.

Schemas are compiled by ajv in strict mode: custom keywords (including `x-*`
annotations) and formats must be registered with the validator, otherwise
updates of that entry fail with a 500 and the error is logged.

The [`@spinajs/validation`](../validation) options apply to the incoming
value: with `useDefaults` the schema's defaults are written into object /
array values before they are stored (so they are fixed at write time),
`coerceTypes` coerces values, and with `removeAdditional` unknown properties
are stripped instead of rejected.

## RBAC

The package ships a dedicated `configuration` role granting `read:any` /
`update:any` on the `configuration` resource, and extends `admin` with it. Grant
the `configuration` role (or `admin`) to give an account access to the API.

## Notes

Writes are persisted to the database only. The running application picks up the
change through the db-source watch poll, and only for entries with `Watch = true`.
