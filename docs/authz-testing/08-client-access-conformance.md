# Client access conformance

`runClientAccessConformance` checks a running app against the client access API that browser clients read: `POST /user/access/checks` with the request bodies of ckit's `createHttpChecker`, `$access` on a list route, the `X-Access-Epoch` header and the `GET /user/access/events` stream. Run it once per app stack that serves these routes.

## How it works

1. `runClientAccessConformance(name, harness, opts)` registers a mocha `describe(name)`. Its `before` hook awaits `harness()` once; its `after` hook calls `app.stop()`.
2. The harness starts the app holding `CLIENT_ACCESS_FIXTURE` and returns a `ClientAccessApp`.
3. The checks run in order with `fetch` against `app.baseUrl`, authenticating with `app.headers('me' | 'other')`; no id means no credential (the app's anonymous principal).
4. `push` changes data (`app.assign('me', 'doc.editor', doc 2)`) and runs last.

## The fixture

`CLIENT_ACCESS_FIXTURE` is what the app must hold when the suite starts:

| Key | Value |
| --- | --- |
| `type` | `doc`, with ids `1`, `2`, `3`, `4` |
| `permissions` | `doc:edit` and `doc:view`, both `{ list: true }` |
| `roles` | `doc.editor` grants `doc:edit`, `doc:view`; `doc.viewer` grants `doc:view` |
| `assignments` | user `me`: `doc.editor` at doc `1` and doc `3`; user `*`: `doc.viewer` at `GLOBAL` |
| `listPath` | `/docs`, served as `.accessible('doc:view').withAccess(['doc:edit', 'doc:view'])` |

`ClientAccessApp`:

| Member | Meaning |
| --- | --- |
| `baseUrl` | Origin of the running app, e.g. `http://127.0.0.1:41234`. |
| `headers(id?)` | Headers that authenticate as user `me` or `other`. |
| `assign(id, role, scope)` | Assigns through `AuthzAdmin`, so the change is pushed. |
| `stop()` | Stops the app. |

## The checks

| Id | What it holds the app to |
| --- | --- |
| `wire` | ckit's default wire format: `{ checks }` in, `{ results }` out, one boolean per check in order; context is never env. |
| `permission-names` | A permission without `:` becomes `<type>:<permission>`; one with `:` is used as given. |
| `isolation` | A malformed or unknown entry is `false` and never fails the batch. |
| `subject` | The subject is the session's principal: another subject is `false` with `subject_mismatch`; no subject, or the caller's own, is the caller. |
| `anonymous` | An anonymous caller may ask and gets `false` where no grant reaches it. |
| `type-level` | Object id `'*'` asks at the type level. |
| `limit` | A batch of ckit's default maximum (100) is answered. |
| `access-field` | Each `$access` entry of a list row equals what `/user/access/checks` answers for that row. |
| `epoch` | `X-Access-Epoch` is stable for a session and differs between principals. |
| `push` | An assignment to the caller pushes `authz.changed` on `GET /user/access/events`, and checks then follow it. |

`clientAccessConformanceChecks(app, opts)` returns the same checks as `ConformanceCheck` objects.

## Configuration

`ClientAccessOptions`:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `timeoutMs` | number | `5000` | ms | Wait for the pushed event; the mocha timeout is three times this. |
| `skip` | `ClientAccessCheckId[]` | `[]` | check ids | Registered as pending. |

## Important behaviour

- The app starts once for all checks, so the checks share its state. Only `push` writes, and it runs last.
- `push` fails when no `authz.changed` event arrives within `timeoutMs`. When the event carries `objects`, they must include doc `2`.
- `wire` also requires `X-Access-Epoch` on the answer, as 16 lowercase hex characters.
- `anonymous` expects `false` for every doc: the `user:*` assignment does not cover the anonymous principal.

## Examples

### Run the suite against an app built with authz-http and authz-rbac

```ts
import { CLIENT_ACCESS_FIXTURE, runClientAccessConformance } from '@spinajs/authz-testing';

runClientAccessConformance('my app: client access', async () => {
  // Your boot code: roles, assignments and the /docs list route from CLIENT_ACCESS_FIXTURE.
  const app = await startApp({
    permissions: CLIENT_ACCESS_FIXTURE.permissions,
    roles: CLIENT_ACCESS_FIXTURE.roles,
    assignments: CLIENT_ACCESS_FIXTURE.assignments,
    docs: CLIENT_ACCESS_FIXTURE.ids,
  });
  return {
    baseUrl: app.url,
    headers: (id) => (id ? { 'x-user': id } : {}),
    assign: (id, role, scope) => app.admin.assign({ type: 'user', id }, role, scope),
    stop: () => app.close(),
  };
});
```

## Related

- [Behaviour fixtures](09-behaviour-fixtures.md): B25 covers `GET /user/access` itself.
- [`@spinajs/authz` adapters](../authz/09-adapters-and-resolvers.md): authz-http serves `/user/access`.
