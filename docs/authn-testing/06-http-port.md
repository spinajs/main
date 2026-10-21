# HTTP port

The `http` port lets the HTTP facets of the [behaviour rules](05-behaviour-rules.md) talk to your app. You implement `HttpPort` over your server (supertest, express, `node:http`); the kit sends requests through it, keeps cookies in a `CookieJar` and adds the headers a browser would.

## How it works

1. A case builds a request: a route builder from `http.routes` (`routes(h).login(login, password)`), or the probe route (`probe(h, 'POST')`).
2. `send(h, request, jar)` adds the app's own `Origin` to an unsafe request that carries neither `Origin` nor `Sec-Fetch-Site`, adds the jar's cookies, and calls `http.send()`.
3. Your `send()` performs the request against the app and returns an `HttpResponse`.
4. `send` stores the response's `Set-Cookie` values in the jar; a cleared or expired cookie is removed.
5. The case asserts on `status`, `headers`, `setCookie` and `body`. Failure bodies are compared after dropping `volatileBodyFields`.

A case that needs a route builder lists it as `http.routes.<name>`; without that builder the case goes pending.

## `HttpPort`

| Member | Type | Meaning |
| --- | --- | --- |
| `send(req)` | `(HttpRequest) => Promise<HttpResponse>` | Sends one request to the app |
| `origin` | `string` | The app's own origin, for example `'https://app.example.test'` |
| `sessionCookie` | `string` | The session cookie name under the case env, prefix included |
| `socketAddress` | `string` | The remote address every request of this port comes from |
| `probePath` | `string` | A route that accepts every method, has no policy, and answers `200` with a JSON `ProbeBody` after all middlewares |
| `routes` | `Partial<HttpRoutes>` | Route builders for request shapes your app defines; each one optional |
| `volatileBodyFields` | `readonly string[]` | Top-level body keys that differ per request (request id, timestamp); default `[]` |

`HttpRequest` is `{ method, path, headers?, cookies?, body? }`. Return an `HttpResponse` with lower-case header names (repeated headers joined with `', '`), `Set-Cookie` values apart in `setCookie`, and `body` as parsed JSON for a JSON content type, else the text, else `undefined`.

`ProbeBody` is `{ principal, clientIp, hits }`: the principal the request resolved to (or `null`), `req.storage.ClientIp`, and how many times the probe handler ran in this harness.

### Route builders

| Builder | Builds |
| --- | --- |
| `login(login, password)`, `logout()`, `whoami()` | Login, logout and the current principal |
| `mfaVerify(code)`, `mfaRecovery(code)` | Complete a pending login with a step or recovery code |
| `mfaStepUp(step, code)`, `mfaGated()` | Step up an active session; a route behind `Authenticated` and `MfaSatisfied` that answers 200 once both pass |
| `mfaEnrol()`, `mfaConfirm(code)`, `mfaDisable(code)` | MFA enrolment and removal |
| `passwordResetRequest(login)`, `passwordReset(login, secret, newPassword)`, `passwordChange(oldPassword, newPassword)` | Password flows |
| `tokenCreate({ name, expiresAt, reauthPassword? })`, `tokenList()` | API tokens |
| `sessionsList()` | The user's sessions |
| `keyChallenge(request)`, `keyLogin({ keyId, challengeId, signature })` | Key challenge login |
| `impersonateStart(target, password?)`, `impersonateStop()` | Impersonation |
| `activeRoleSet(role, password?)` | Role switch |
| `adminPasswordReset(target)`, `adminMfaReset(target)`, `adminSessionsRevoke(target)`, `adminTokensRevoke(target)` | Credential admin routes |

Each builder returns an `HttpRequest`. The kit does not fix paths or body shapes; your builder decides them. The one exception is OIDC: the A27 cases send requests to `/auth/oidc/<provider>` and `/auth/oidc/<provider>/callback` directly, with `provider` from the `oidc` port.

## Request helpers

| Helper | Effect |
| --- | --- |
| `send(h, req, jar?)` | Adds `Origin` like a browser, applies and stores cookies; a fresh jar when omitted |
| `sendRaw(h, req, jar?)` | Like `send`, without adding `Origin`; the CSRF and CORS rules use it |
| `withOrigin(http, req)` | The request with `Origin: http.origin` added when `send` would add it |
| `routes(h)` | The route builders, typed as complete |
| `probe(h, method)` | A request to `probePath` |
| `in4xx(status)` | `true` for 401 or 403 |
| `stripBody(h, body)` | The body without `volatileBodyFields` |
| `expectSameBody(h, x, y, msg?)` | Asserts two response bodies are equal after stripping |
| `sessionCookieOf(h, res)` | The parsed `Set-Cookie` of the session cookie, or `undefined` |
| `sessionJar(h, value)` | A jar holding only the session cookie with that value |

### `CookieJar`

`apply(req)` adds the stored cookies (cookies already on the request win), `store(res)` reads `Set-Cookie`, and `get`, `set` and `clear` manage cookies by name. `parseSetCookie(lines)` parses raw values into `{ name, value, attributes }` with lower-case attribute names; `isCleared(cookie, now)` tells whether a cookie is emptied or expired.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| HTTP transport | the `http` port of your harness | none | supertest, express, `node:http` | Implement `HttpPort.send` |
| Route shapes | `HttpPort.routes` | none | none | Add a builder per route your app has |

## Important behaviour

- The jar ignores domain, path and `Secure`: one app, one origin.
- Cookie expiry compares with `new Date()`, which follows the case clock only while it is installed.
- `send` never adds `Origin` to `GET`, `HEAD` or `OPTIONS`.
- 401 bodies are compared across failure reasons (A02). Any field that changes per request breaks that comparison unless it is in `volatileBodyFields`.
- `socketAddress` must be the address the app sees on the socket, and must differ from `SPOOF_IP`; A05 checks that a spoofed `X-Forwarded-For` does not replace it in `ProbeBody.clientIp`.

## Best practices

- Keep request ids and timestamps out of 401 bodies, or list them in `volatileBodyFields`.
- Start one server per case and stop it in `dispose()`, so cookies, probe hits and middleware state never leak between cases.
- Implement only the route builders your app has; the cases needing the others stay pending and say which builder is missing.

## Patterns and antipatterns

```ts
// Don't: sendRaw sends no Origin, so the CSRF guard refuses an ordinary browser POST
const res = await sendRaw(h, routes(h).passwordChange(ALICE.password, NEW_PW), jar);

// Do: send behaves like a browser on the app's own page
const res = await send(h, routes(h).passwordChange(ALICE.password, NEW_PW), jar);
```

## Examples

### An `HttpPort` over `node:http`

```ts sample
import { request } from 'node:http';
import type { HttpPort, HttpRequest, HttpResponse } from '@spinajs/authn-testing';

export function httpPort(base: string): HttpPort {
  const send = (req: HttpRequest): Promise<HttpResponse> =>
    new Promise((resolve, reject) => {
      const cookie = Object.entries(req.cookies ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
      const r = request(
        new URL(req.path, base),
        {
          method: req.method,
          headers: { ...req.headers, ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (k !== 'set-cookie' && v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
            }
            const json = (headers['content-type'] ?? '').includes('json');
            resolve({ status: res.statusCode ?? 0, headers, setCookie: res.headers['set-cookie'] ?? [], body: text === '' ? undefined : json ? JSON.parse(text) : text });
          });
        },
      );
      r.on('error', reject);
      r.end(payload);
    });

  return {
    send,
    origin: new URL(base).origin,
    sessionCookie: 'ssid',
    socketAddress: '127.0.0.1',
    probePath: '/test/probe',
    routes: {
      login: (login, password) => ({ method: 'POST', path: '/auth/login', body: { login, password } }),
      logout: () => ({ method: 'POST', path: '/auth/logout' }),
      whoami: () => ({ method: 'GET', path: '/auth' }),
    },
    volatileBodyFields: ['requestId'],
  };
}
```

The cookie name, the probe path and the routes are your app's; the values here are placeholders.

## Related

- [Behaviour runner](04-behaviour-runner.md): where the `http` port fits in the harness.
- [Behaviour rules](05-behaviour-rules.md): the HTTP facets and the route builders each needs.
- [`@spinajs/authn-http`](../authn-http/README.md): the SpinaJS HTTP layer these facets check.
