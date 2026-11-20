# Audit

`Audit` is a route middleware of `@spinajs/audit-http` that records who did what on a route as an `action` event of
the [audit trail](../../packages/audit/README.md): the method and route, the redacted URL, query and body, the status,
the error an error reply answered, the time taken and whether the client went away. The actor, the impersonator, the
client address and the trace id are stamped by the audit context. The event goes to the trail named by `trail`,
`default` unless set.

```ts sample
import { Audit } from '@spinajs/audit-http';
import { BaseController, BasePath, Body, Del, Middleware, NoContent, Ok, Param, Post } from '@spinajs/http';

@BasePath('admin/users')
@Middleware(Audit)
export class AdminUsersController extends BaseController {
  @Post('/')
  public create(@Body() user: object) {
    return new Ok(user);
  }

  @Del(':id')
  public remove(@Param() _id: number) {
    return new NoContent(null);
  }
}
```

`Audit` is registered as `RouteMiddleware`, so it can audit every route of the app as a
[global route middleware](../http/14-route-middlewares.md#global-route-middlewares):

```ts sample
// the app's config file
export default {
  http: { routes: { middlewares: ['Audit'] } },
  audit: { http: { methods: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
};
```

Mounting is what switches auditing on. Nothing else does: a rule of `audit.http.rules` refines a route where `Audit`
is mounted; it does not mount it.

## Configuration

`audit.http` applies to every `Audit`. `@Middleware(Audit, options)`, or `{ service: 'Audit', options: [options] }` in
`http.routes.middlewares`, overrides it for those routes. Each `Audit` gets its own instance, so its options stay its
own. The order is: the options of the declaration, then the first matching rule, then `audit.http`, then the defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `methods` | unset: every method | HTTP methods audited, eg. `['POST', 'DELETE']`, in any case. A route whose method is not listed does not mount the middleware; a `HEAD` request to a `GET` route runs its action, so it is judged by `GET`. |
| `redact` | `['password', 'token', 'secret', 'authorization', 'cookie', 'card']` | Keys whose values are recorded as `[redacted]`. In `audit.http` the list replaces the default; in route options it adds to the configured list. Apps often add `apikey`, `privatekey`, `otp`, `cvv`, `cvc`, `credential`, `passwd` and `pwd`. |
| `includeBody` | `true` | Whether the request body is recorded. |
| `maxBodyBytes` | `16384` | A body larger than this, by its `Content-Length` or as JSON after redaction, is left out; `bodyTruncated` holds its size. |
| `trail` | `default` | The trail the events are written to, a name of `audit.trails`. |
| `action` | the route name, `http:<METHOD> <mounted path>` | The event's `action`. Set on a route it is used as it is. Set for several routes at once (on a controller, in a global entry, in `audit.http`) it is a prefix: each route records `<action>.<method name>`, so their events stay apart. |
| `abortWaitMs` | `30000` | How long the event of a request the client went away from waits for the action to end, in milliseconds (0 to 2147483647). See [A request the client went away from](#a-request-the-client-went-away-from). |
| `rules` | none | `audit.http` only. Per-route `action` and `trail`, see [Rules](#rules). |

A key `audit.http` does not know (a misspelt `trial`) fails the boot. A trail that does not exist, a trail whose
store is not registered, or an `action` that is empty or longer than 128 characters fails the registration of the
route, so the application does not boot. A default route name longer than
that is cut in `action`; `data.route` holds it whole.

```ts sample
import { Audit } from '@spinajs/audit-http';
import { BaseController, BasePath, Body, Middleware, Ok, Post } from '@spinajs/http';

@BasePath('payments')
export class PaymentsController extends BaseController {
  // `pin` and `iban` join the configured keys on this route only
  @Post()
  @Middleware(Audit, { redact: ['pin', 'iban'], trail: 'payments', action: 'payment.create' })
  public pay(@Body() payment: object) {
    return new Ok(payment);
  }

  // the body of an upload is not worth keeping
  @Post()
  @Middleware(Audit, { includeBody: false })
  public importStatement(@Body() statement: object) {
    return new Ok(statement);
  }
}
```

### Rules

`audit.http.rules` gives routes another action or trail without touching their controllers. A rule is
`{ match, action?, trail? }`. `match` is `<METHOD or *> <path pattern>`, matched against the mounted path with the
route parameters as written (`/admin/users/:id`): `*` is one path segment, `**` any number of them. The first rule
that matches wins, and it wins whole: a field it leaves unset is not taken from a later rule that also matches. A
rule's `action` is used as it is for every route it matches.

```ts sample
// the app's config file
export default {
  http: { routes: { middlewares: ['Audit'] } },
  audit: {
    trails: {
      restricted: { store: 'TableAuditStore', onFailure: 'reject' },
      reports: { store: 'TableAuditStore' },
    },
    http: {
      rules: [
        { match: 'DELETE /admin/**', action: 'admin.delete', trail: 'restricted' },
        { match: '* /reports/*', trail: 'reports' },
      ],
    },
  },
};
```

A rule refines a route where `Audit` is mounted; it does not mount it. A rule fails the boot when it holds a key
other than `match`, `action` and `trail`, when it has no method and pattern (`audit.http.rules[<i>]: match must be
'<METHOD or *> <path pattern>', and action and trail, when given, a name`), and when it sets neither `action` nor
`trail` (`audit.http.rules[<i>]: a rule sets action, trail or both`). A rule naming a trail that does not exist fails
the registration of the routes it matches. `matchesRoute(pattern, method, path)` is exported for tests of your own rules.

## Redaction

- A key is sensitive when it contains one of the `redact` entries, ignoring case: `token` covers `accessToken`,
  `refresh_token` and `X-Token`, `card` covers `creditCard` and `cards`. A substring match errs on the side of hiding:
  `discard` is redacted too.
- The value of a sensitive key is replaced as a whole, an object or an array included.
- Redaction is recursive, through objects and arrays at any depth. Binary data is recorded as `[binary]`, a circular
  reference as `[circular]`, anything nested deeper than 32 levels as `[too deep]`. The request's own objects are
  never changed.
- A body that is not an object or an array, such as a text or XML body, has no keys to redact by, so it is recorded
  as `[redacted]`.
- `url` replaces every query value with `[redacted]`, as the access log does, and every path segment that holds a
  route parameter with a sensitive name: `GET /reset/:token` is recorded as `/reset/[redacted]`. A parameter that
  shares its segment with other text (`/:token.json`) is not found. `query` holds the parsed query, redacted by key,
  so a non-sensitive value such as `page` stays readable there.
- An empty body or query is left out of the event.
- A multipart body (`@Form`, `@File`) is parsed by the route arguments, after `Audit` ran, so it is not recorded.

The trail's own `omit`, `mask` and `hash` paths run after this redaction, on the event as `Audit` built it:

- A `hash` path on a key the redaction already replaced hashes the constant `[redacted]`, so equal values can no
  longer be matched. To keep a value correlatable, leave its key out of `redact` and hash it on the trail.
- Trail paths name each level: an array needs an explicit `*` (`data.body.payments.*.card`), where `redact` matches
  a key at any depth.

## The event

| Field | Meaning |
| --- | --- |
| `kind` | `action`. |
| `action` | See `action` under [Configuration](#configuration). |
| `outcome` | `ok` for a reply without an error; `denied` for a refusal of the [policy gate](../http/13-policies.md); `failed` for any other error reply, a policy that crashed (a 500) included; `attempt` for the event a `reject` trail confirms before the route runs (see [Trails and failure](#trails-and-failure)), and for a request the client went away from whose action had not ended within `abortWaitMs`. |
| `at` | When the request reached the middleware. |
| `actor`, `onBehalfOf` | `actor` is the effective principal and `onBehalfOf` its impersonator, both stamped by the audit context when the event is recorded. |
| `origin` | The client address: `ClientIp` of `@spinajs/authn-http`, else `realIp` of `@spinajs/http`. |
| `traceId` | The request's trace id. |

`data`:

| Field | Meaning |
| --- | --- |
| `route` | `http:<METHOD> <mounted path>`, as `ctx.path`. |
| `method`, `url` | The request method and the redacted URL. |
| `status` | The sent status. Unset when the client went away before the headers were sent, and on an `attempt`. |
| `ms` | Time from the middleware's `onBefore` to the end of the response. |
| `aborted` | `true` when the client went away before the response finished. The outcome is then the action's, see [A request the client went away from](#a-request-the-client-went-away-from). |
| `requestId` | From `req.storage`, set by `RequestId`. |
| `query`, `body`, `bodyTruncated` | See [Redaction](#redaction) and `maxBodyBytes`. |
| `error` | The error an error reply answered: a policy refusal, a middleware's refusal, an exception of the action, a throwing `onAfter`. `name` always; `message` only when the error is not answered as a 500 (a mapped 4xx, eg. `Forbidden`), cut to 200 characters. The message of a 500 can carry internals or quote input (a `SyntaxError`, a driver error with bound values): find it in the `http` log by `requestId`. |
| `invocation` | On a `reject` trail: the id that joins the `attempt` to its outcome event. |

A field with no value is left out of the event.

## When a request is recorded

`Audit` runs in the `'beforePolicy'` [stage](../http/14-route-middlewares.md#stage), so it records the requests the
route's [policies](../http/13-policies.md) refuse (status 401 or 403, the refusal as `error`, the outcome `denied`) and
what every later middleware refuses. It records nothing for:

- a request answered before routing: a server middleware's refusal, a 404, a static file;
- a request refused or answered by a `'beforePolicy'` middleware that runs before `Audit` ([entry order](../http/14-route-middlewares.md#entered-middlewares)).

### A request the client went away from

When the client goes away before the response finished, the action may still run: `POST /payments` can commit a
second after the client dropped. `Audit` waits for the action to end (`ctx.settled` of the
[finish hook](../http/14-route-middlewares.md)), for at most `abortWaitMs`, and records the event with
`data.aborted: true`:

| The action | `outcome` |
| --- | --- |
| ends with a result after the client left | `ok` |
| throws, or stops on the abort signal | `failed` with `data.error`; `denied` for a refusal of the policy gate, `failed` for a policy that crashed |
| is still running after `abortWaitMs` | `attempt`: the result is unknown |

`status` and `ms` are taken when the connection closed, so `status` stays unset unless the headers had been sent.
The wait holds no timer that keeps the process alive. When the http server begins to close (`http.server.closing`),
every pending wait ends at once and its event is recorded as `attempt`, and so is a wait that begins later: a request
the closing server cut off. On a `reject` trail the event is the one outcome that follows the confirmed attempt.
`Audit` hears the event on the container it was resolved in; when `HttpServer` belongs to another container, the
pending waits end only after `abortWaitMs`.

## Trails and failure

On a `continue` trail (the default), one event is written after the response finished. It is deferred: the audit
service buffers it and writes it in batches, and a write that fails is logged on the `audit-pipeline` logger with the
event ids. The request never fails because of it.

On a `reject` trail (`onFailure: 'reject'`), `Audit` writes two events:

1. In `onBefore`, which runs at `'beforePolicy'` (after the server middlewares, before the policy gate, the other
   middlewares and the action), it captures the request and confirms an `attempt` event. The attempt carries
   `data.invocation`.
2. When that write fails after the trail's retries, the request is answered **503** (`AuditUnavailable`, registered
   for `AuditWriteFailed`) with the problem document of a server error, its message hidden in production. The policy
   gate and the action do not run, and no outcome event follows.
3. When the write succeeded, the route runs. Once the response finished, the outcome event (`ok`, `denied`, `failed`)
   is confirmed with the same `data.invocation` and `onFailure: 'continue'`: the response is out, so a failed write
   is logged and leaves an attempt without an outcome, which is what a crash in between leaves too.

An attempt without an outcome reads: the route ran, or may have; its result is unknown.

A trail the audit service refuses as misconfigured raises `AuditConfigError`, which no `onFailure` swallows. On the
outcome write it is thrown out of `onFinish` after the response was sent, and logged on the `http` logger, not on
`audit-pipeline`.

A rejecting trail is an availability dependency: when its store is down, every audited request answers 503. With
`@spinajs/audit-http` installed, an `AuditWriteFailed` from anywhere in a request answers 503, a rejected read of
`@AuditReads` included. A trail the audit service refuses as misconfigured (a store that raises `AuditConfigError`)
is a fault of the server, which no retry fixes: the attempt then answers 500, not 503.

The attempt is recorded inside the request's context, so it carries the principal that the server middlewares of
`@spinajs/authn-http` and `@spinajs/authz-http` set before routing. On a route whose policy authenticates, the attempt
is stamped `unattended`; the outcome event has the principal.

### The `default` trail needs a store

The built-in `default` trail is a table of `@spinajs/audit-orm` (`TableAuditStore`). Without that package, mounting
`Audit` on it fails the boot with `audit: trail "default" names the store "TableAuditStore", and no AuditStore is
registered under that name`. For log-only use:

```ts sample
// the app's config file
export default {
  audit: { trails: { default: { store: 'LogAuditStore' } } },
};
```

### Shutdown

A request the client went away from and whose action still runs is recorded as `attempt` when the http server begins
to close (see [A request the client went away from](#a-request-the-client-went-away-from)). Deferred events wait in the audit service of the container that resolved the controllers, one service per container.
They are written when that container is disposed; disposing the root container disposes its children first, so
`DI.dispose()` at shutdown writes them all. `audit().flush()` reaches only the root's service: an application that
resolves its server in a child container flushes with `audit(container).flush()` on that container, or disposes it.

## Related

- [`@spinajs/audit`](../../packages/audit/README.md): trails, stores, write modes and the audit context.
- [Route middlewares](../http/14-route-middlewares.md): hooks, stages and global route middlewares.
- [Request storage and tracing](../http/19-request-storage-and-tracing.md): the access log, which logs every request
  without bodies.
- [Client IP and trusted proxies](../http/17-client-ip-and-trust-proxy.md): where `origin` comes from.
