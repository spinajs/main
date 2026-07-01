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

## RBAC

The package ships a dedicated `configuration` role granting `read:any` /
`update:any` on the `configuration` resource, and extends `admin` with it. Grant
the `configuration` role (or `admin`) to give an account access to the API.

## Notes

Writes are persisted to the database only. The running application picks up the
change through the db-source watch poll, and only for entries with `Watch = true`.
