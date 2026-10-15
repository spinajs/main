# ckit hand-off: spinajs client access API

Date: 2026-10-14. For: the owner of the ckit repo (`coderush/ckit`, package `ckit-access`).
From: spinajs authz 3.0 (`docs/plans/2026-10-14-authz-resource-access-design.md`, §10).

spinajs now serves a client access API that ckit's `createHttpChecker` talks to with its defaults. Three
pieces belong in ckit and are not built on the spinajs side. spinajs CI runs
`runClientAccessConformance` (`@spinajs/authz-testing`) with the request fixtures of
`packages/access/src/http.test.ts`, so a server change that breaks the defaults fails there first.

## What the server answers

- `POST /user/access/checks`
  - request: `{ checks: [{ object: { type, id }, permission, subject?, context? }] }`, at most 100
    entries (ckit's `DEFAULT_MAX_BATCH_SIZE`);
  - response: `200 { results: boolean[], reasons: (string | null)[] }`, one entry per check, in order;
  - `true` only for a definite allow; a bad entry is `false` and never fails the batch;
  - `subject` must be the session's principal, else `false` with `subject_mismatch`;
  - `context.field` and `context.fieldMode` (`read` | `write`, default `write`) narrow to one field;
    nothing else in `context` is read (an `ip` there is ignored);
  - `permission` without `:` becomes `<object.type>:<permission>`; `object.id === '*'` asks at the type
    level; `object.type === '$global'` is the global scope;
  - anonymous callers may ask; no principal at all is `401`.
- `X-Access-Epoch` on every response of `authn-http` and `authz-http`: 16 hex characters per session,
  changes on login, role switch, MFA elevation and impersonation start and end.
- `GET /user/access/events` (SSE): `event: authz.changed`, `data: { "objects"?: [{ "type", "id" }] }`.
  `objects` is present only when exact; absent means "anything may have changed". The http-socket
  channel pushes the same event name and payload.
- List responses built with `.withAccess([...])` carry `$access: { [permission]: boolean }` per row
  (the key is configurable server-side, `authz.orm.accessField`). Each entry equals what
  `/user/access/checks` answers for `(row, permission)`.
- `authz:export-model [--out file.d.ts]` writes `export type AccessModel = { [type]: action union }`,
  usable as ckit's `AccessRegister` model.
- `format=tree` on the explain route (development only) answers `{ label, allowed, children }`, the
  shape of ckit's `ExplainNode`.

## Work in ckit

1. **Seed API.** `access.seed(entries)`: load `$access` answers into the store as settled answers, for
   example `seed(rows.flatMap((r) => Object.entries(r.$access).map(([permission, allowed]) => ({ object:
   { type, id: r.id }, permission, allowed }))))`. A seeded `(object, permission)` must equal a fetched
   one; a later `invalidate`/`subscribe` notification drops seeded entries like fetched ones.
2. **Epoch hook.** An option on `createHttpChecker`, e.g. `onResponse(response)` or
   `epochHeader: 'X-Access-Epoch'`, that compares the header with the last value and, on a change,
   drops every cached answer (the same as `invalidate()` with no filter). Without it a role switch
   leaves stale answers until the next push.
3. **Docs.** A spinajs section in `docs/access-control.md`: the endpoint and defaults above; the
   subject is taken from the session (send it or not); wire `subscribe` to `GET /user/access/events`
   (or the socket channel) with `changed` = `objects`, and no argument when `objects` is absent; seed
   from `$access`; the epoch hook; fail closed (anything but `true` denies).
4. **Later.** When the file manager moves to `ckit-access`: fs object ids as `<fs>:` +
   `encodeURIComponent(path)` (ckit ids forbid whitespace). Deferred on the spinajs side too
   (`authz-fs` decodes them only once this lands).

## Contact points

- Conformance: `packages/authz-testing/src/conformance/client-access.ts` (`CLIENT_ACCESS_FIXTURE`).
- Server: `packages/authz-http` (`AccessController`, SSE, epoch middleware), `packages/authz-orm`
  (`.withAccess`), `packages/http-socket` (socket transport).
