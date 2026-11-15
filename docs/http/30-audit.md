# Audit

`Audit` is a route middleware that records who did what on a route: the method and route, the redacted URL, query
and body, the status, the error an error reply answered, the principal, the time taken and whether the client went
away. It hands one `IAuditRecord` per request to an `AuditSink` once the response finished. The default sink writes
it on the `audit` logger.

```ts sample
import { Audit, BaseController, BasePath, Body, Del, Middleware, NoContent, Ok, Param, Post } from '@spinajs/http';

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
[global route middleware](14-route-middlewares.md#global-route-middlewares):

```ts sample
// the app's config file
export default {
  http: {
    routes: { middlewares: ['Audit'] },
    audit: { methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },
  },
};
```

## Configuration

`http.audit` applies to every `Audit`. `@Middleware(Audit, options)`, or `{ service: 'Audit', options: [options] }` in
`http.routes.middlewares`, overrides it for those routes. Each `Audit` gets its own instance, so its options stay its
own.

| Key | Default | Meaning |
| --- | --- | --- |
| `methods` | unset: every method | HTTP methods audited, eg. `['POST', 'DELETE']`, in any case. A route whose method is not listed does not mount the middleware; a `HEAD` request to a `GET` route is judged by `HEAD`. |
| `redact` | `['password', 'token', 'secret', 'authorization', 'cookie', 'card']` | Keys whose values are recorded as `[redacted]`. In `http.audit` the list replaces the default; in route options it adds to the configured list. Apps often add `apikey`, `privatekey`, `otp`, `cvv`, `cvc`, `credential`, `passwd` and `pwd`. |
| `includeBody` | `true` | Whether the request body is recorded. |
| `maxBodyBytes` | `16384` | A body larger than this, by its `Content-Length` or as JSON after redaction, is left out; `bodyTruncated` holds its size. |

```ts sample
import { Audit, BaseController, BasePath, Body, Middleware, Ok, Post } from '@spinajs/http';

@BasePath('payments')
export class PaymentsController extends BaseController {
  // `pin` joins the configured keys on this route only
  @Post()
  @Middleware(Audit, { redact: ['pin', 'iban'] })
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
  shares its segment with other text (`/:token.json`) is not found. `query` holds the
  parsed query, redacted by key, so a non-sensitive value such as `page` stays readable there.
- An empty body or query is left out of the record.
- A multipart body (`@Form`, `@File`) is parsed by the route arguments, after `Audit` ran, so it is not recorded.

## The record

| Field | Meaning |
| --- | --- |
| `at` | When the request reached the middleware. |
| `route` | `http:<METHOD> <mounted path>`, as `ctx.path`. |
| `method`, `url` | The request method and the redacted URL. |
| `status` | The sent status. Unset when the client went away before the headers were sent. |
| `ms` | Time from the middleware's `onBefore` to the end of the response. |
| `aborted` | `true` when the client went away before the response finished. |
| `requestId`, `ip` | From `req.storage`, set by `RequestId` and `RealIp`. |
| `principal` | `{ type, id, impersonator? }` of `req.storage.Principal` (set by `@spinajs/authz-http`), or of `req.storage.AuthnPrincipal` (set by `@spinajs/authn-http`) without authz. Read when the response finished, so a principal set by any middleware or the action counts. |
| `query`, `body`, `bodyTruncated` | See [Redaction](#redaction) and `maxBodyBytes`. |
| `error` | The error an error reply answered: a policy refusal, a middleware's refusal, an exception of the action, a throwing `onAfter`. `name` always; `message` only when the error is not answered as a 500 (a mapped 4xx, eg. `Forbidden`), cut to 200 characters. The message of a 500 can carry internals or quote input (a `SyntaxError`, a driver error with bound values): find it in the `http` log by `requestId`. |

A field with no value is left out of the record.

## When a request is recorded

`Audit` runs in the `'beforePolicy'` [stage](14-route-middlewares.md#stage), so it records the requests the route's
[policies](13-policies.md) refuse (status 401 or 403, the refusal as `error`) and what every later middleware refuses.
It records nothing for:

- a request answered before routing: a server middleware's refusal, a 404, a static file;
- a request refused or answered by a `'beforePolicy'` middleware that runs before `Audit` ([entry order](14-route-middlewares.md#entered-middlewares)).

## Sinks

| Service | DI token and lifetime | Default implementation | How to replace |
| --- | --- | --- | --- |
| `AuditSink` (abstract) | `AuditSink`, the implementation's own lifetime | `LogAuditSink`: one `info` line per record on the `audit` logger, the record as its fields | `@Injectable(AuditSink)` on your class; the last registered implementation is used. |

`write(record)` may return a promise. `Audit` awaits it after the response was sent, so a slow sink never delays the
client. A sink that throws or rejects is logged on the `http` logger with the route, and never fails the request.
One sink serves every route: a sink that must write to several stores fans out itself. A sink must settle: `Audit`
does not time it out, and a promise that never settles keeps its record in memory.

```ts sample
import { Injectable } from '@spinajs/di';
import { AuditSink, IAuditRecord } from '@spinajs/http';

interface AuditRow {
  at: Date;
  route: string;
  status?: number;
  actor?: string;
  record: IAuditRecord;
}

/** Keeps the records in memory; a real one inserts them into a table or sends them to a queue. */
@Injectable(AuditSink)
export class TableAuditSink extends AuditSink {
  public readonly rows: AuditRow[] = [];

  public async write(record: IAuditRecord): Promise<void> {
    const actor = record.principal ? `${record.principal.type}:${record.principal.id}` : undefined;
    this.rows.push({ at: record.at, route: record.route, status: record.status, actor, record });
  }
}
```

## Related

- [Route middlewares](14-route-middlewares.md): hooks, stages and global route middlewares.
- [Request storage and tracing](19-request-storage-and-tracing.md): the access log, which logs every request without
  bodies.
- [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md): where `ip` comes from.
