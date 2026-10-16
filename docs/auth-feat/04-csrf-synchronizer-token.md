# CSRF Synchronizer Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A request that carries the session cookie can prove it comes from the app with a session-bound CSRF token. So a client whose Origin and Sec-Fetch-Site headers were stripped is no longer hard-refused, and an app can require both proofs. A login from a foreign site is refused.

**Architecture:** The token is `HMAC-SHA256(key, domain ‖ sessionHandle)`. `sessionHandle` is the one-way handle of `AuthnFacts.sessionHandle`, derived from the raw id in the cookie, so the server stores nothing and the token changes whenever the session id rotates. `CsrfOriginGuard` (Order 4) verifies it from `X-CSRF-Token` or the `_csrf` field, according to `authn.http.csrf.mode`. It publishes it in `req.storage.CsrfToken` for `GET /auth/csrf`. It also sets a readable `authn-csrf` cookie whenever the response sets the session cookie, and on safe requests that lack it. A method policy guards `POST /auth/login` against login CSRF. Refusals are audited as `csrf.reject`.

**Tech Stack:** TypeScript, Express via `@spinajs/http`, `node:crypto` (HMAC-SHA256, HKDF, `timingSafeEqual`), `cookie-signature`, mocha + chai / `node:assert`, the `@spinajs/authn-testing` behaviour kit.

## Global Constraints

- English comments, identifiers and commits. Comment only what the code cannot say.
- One commit per task. Run the package suites before each commit.
- Run tests from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`. authn-http's `npm test` runs both mocharc files: unit and `v3-app`.
- After changing a package, rebuild it before testing its dependants: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
- Working-copy files use CRLF. Keep them CRLF.
- Value checks and defaults go in the authn JSON schema. The guard keeps its by-hand floors, because 2.x apps never register the authn schema (precedent: `fix(authz-http): fail closed on a non-boolean explain switch`).
- Secrets are secret references, never inline values.
- HTTP work targets the 3.0 layer (`packages/authn-http/src/v3`). The guard itself is shared with 2.x.
- Each new behaviour rule gets a row in `packages/authn-testing`. This plan takes **A33**. If another plan has taken A33 by the time this one lands, use the next free number everywhere `A33` appears.
- Message IDs for this plan: **4002000–4002999** (docs/auth-feat/README.md). Audit event: **`csrf.reject`**.
- Commit only your own hunks. Check `git diff --cached --stat` before each commit.

**Depends on:** plan 03 (message IDs), for Task 6 only. Tasks 1-5 do not need it. Until 03 lands, refusal bodies keep their `code` strings: `E_CSRF_ORIGIN` (existing) and `E_CSRF_TOKEN` (new).

---

## Current state

- `CsrfOriginGuard` (`packages/authn-http/src/middleware/csrf.ts:100-141`, Order 4 at `:110`) checks unsafe methods (anything but GET, HEAD and OPTIONS, `:13`) that carry a session cookie under the bare or `__Host-` name (`:119-122,126`). The request passes when `Origin` is the own origin or listed in `authn.http.csrf.allowedOrigins`, or, without Origin, when `Sec-Fetch-Site: same-origin` (`:128-131`). Anything else gets 403 `{ error: { code: 'E_CSRF_ORIGIN', … } }` (`:15,134`). A request with neither header is always refused. A request without the session cookie, login included, is never checked (`:98`).
- Config is read by hand with `InvalidOption` floors: `isEnabled` at `:37-47`, `allowedOrigins` at `:25-35`. The schema block is `packages/authn/src/schemas/authn.configuration.ts:373-379` (`enabled` default true, `allowedOrigins` default `[]`).
- The session cookie is SameSite=Strict, HttpOnly and signed (`packages/authn-session/src/cookie.ts:98-122`). It carries the raw id. `AuthnMiddleware` (Order 5, `packages/authn-http/src/middleware/authn.ts:73`) unsigns it from `req.cookies` or reads `req.signedCookies` (`:136-152`).
- No token exists, there is no `GET /auth/csrf`, and refusals are not audited.

## Decisions (confirm before Task 1)

1. **Stateless synchronizer token, `base64url(HMAC-SHA256(key, "spinajs:authn-http:csrf\0" + sessionHandleOf(storageKeyOf(rawId))))`.** Nothing is stored. The handle is the value `AuthnFacts.sessionHandle` carries (`issuer.ts:260-262,331`). The token rotates with every new session id: login, MFA completion, role switch, impersonation start and stop.
2. **Key: `authn.http.csrf.secret.secret` (optional secret ref, ≥ 32 chars), else HKDF-SHA256 from `http.cookie.secret` (info `spinajs:authn-http:csrf-key`).** With the default mode no app needs a new secret and no boot breaks. HKDF keeps the two uses of the cookie secret apart. A key is needed because the handle itself is shown in `GET /user/sessions` and in the audit stream.
3. **Default mode `origin-or-token`.** For every request that carries Origin or Sec-Fetch-Site, the outcome is the same as today's `origin`. A request with neither now passes, but only with a valid token, and a valid token proves the client could read a same-origin answer. So the default lowers no effective security value (mechanism-notes, "Lessons"). `origin-and-token` is opt-in defence in depth.
4. **A foreign Origin (or a non-`same-origin` Sec-Fetch-Site) is refused in every mode, even with a valid token.** When the browser names another site, a token does not override it.
5. **The token check stays in `CsrfOriginGuard`, before `AuthnMiddleware`.** It derives the handle from the cookie, so it needs no session restore. A token of an ended or unknown session still verifies, which is harmless: such a cookie authenticates nothing.
6. **Delivery: `GET /auth/csrf` → `{ Token }`, and a readable cookie `authn-csrf`** (`__Host-authn-csrf` outside development and test, following the session cookie's prefix rule). The cookie is SameSite=Strict, never HttpOnly, and always host-only. The guard wraps `res.cookie` for the request: every Set-Cookie of the session cookie (3.0 controllers, `authn-oidc`, 2.x renewals, all of which go through `res.cookie`) brings the token cookie of the new id, or its removal. A safe request whose token cookie is missing or stale gets it set. Editing each call site instead would miss OIDC and 2.x.
7. **Login CSRF: a method policy `LoginOriginPolicy` on `POST /auth/login`.** It refuses a login whose Origin, or Sec-Fetch-Site without Origin, names another site. A login that sends neither header passes, as native and CLI clients do. There is no pre-session token: every browser shipped since 2023 sends Sec-Fetch-Site, and a token cookie set before login adds state for clients that do not need it.
8. **Refusal bodies:** `E_CSRF_ORIGIN` (origin evidence missing or foreign) and the new `E_CSRF_TOKEN` (`CSRF token missing or invalid`). IDs `4002001` and `4002002` follow in Task 6 (needs plan 03).
9. **Audit `csrf.reject`**, `outcome: 'failure'`, `reason: 'origin' | 'token' | 'login-origin'`, `data: { mode, method }`, plus `session` (the hashed handle) when the cookie verifies. It is capped at 60 events a minute per process, because refusals are client-driven. The guard audits only when the 3.0 layer is registered: a 2.x app must not load `@spinajs/authn` just for this.
10. **`_csrf` is read from any body the parsers already parsed (urlencoded, JSON).** Multipart bodies are parsed after the guard, so a multipart form must send the header.

## Security notes

- Addressed: CSRF through a proxy, extension or old client that strips Origin and Sec-Fetch-Site. Such a request now needs a token that only same-origin script can read. `origin-and-token` gives two independent proofs. A cookie injected from a sibling subdomain cannot forge a token, because verification is an HMAC of the victim's own session handle, not an equality with the cookie. Login CSRF from modern browsers is refused. Comparison is constant-time. Tokens die with the session id, so a token from before a login, MFA step, role switch or impersonation is refused afterwards.
- Residual: XSS can read the token. It could also act directly, so the token does not change that. Login CSRF from a browser that sends neither header is not caught. A token is valid for the whole life of a session id, not per request. If `http.cookie.secret` leaks while no own `authn.http.csrf.secret` is set, tokens can be forged, but session cookies can be forged then too. GET handlers with side effects stay unprotected, by convention.

## Facts verified (2026-10-06)

- `csrf.ts`: `SAFE_METHODS` `:13`, `ALLOWED_ORIGINS_KEY` `:14`, `REFUSED` `:15`, `ownOrigin` `:21-23`, `allowedOrigins` `:25-35`, `isEnabled` `:37-47`, `RefusalWarnings` `:60-88`, `carriesCookie` `:90-92`, guard `:100-141`.
- `packages/authn-session/src/issuer.ts`: `MAX_RAW_ID_LENGTH = 128` `:37`, `storageKeyOf` `:52`, `sessionHandleOf` `:64`, `handleOfRow` `:260-262`. A legacy 2.x row and a migrated row both list `sessionHandleOf(storageKeyOf(rawId))`. Both functions are exported through `packages/authn-session/src/index.ts:11`.
- `packages/authn-session/src/cookie.ts`: `SESSION_COOKIE_BASE_NAME` `:24`, `appEnvOf` `:65`, `sessionCookieName` `:85`, `sessionCookieOptions` `:98` (drops `name`/`hostPrefix`, then forces `httpOnly`, `secure`, `sameSite`, and with the prefix `path: '/'` and no `domain`), `clearSessionCookie` `:154` (`Value: ''`, maxAge 0).
- `_setCoockies` (`packages/http/src/responses.ts:21-50`) signs a `signed` cookie by hand and calls `res.cookie(name, value, { …, signed: false })`. authn-oidc sets its cookies through it (`OidcController.ts:35`).
- Body parsers and the cookie parser are in `http.middlewares` (`packages/http/src/config/http.ts:94-117`). They are applied before every `ServerMiddleware` (`packages/http/src/server.ts:128-141`), so `req.body` (urlencoded, JSON) and `req.cookies` exist at Order 4.
- Session cookies are set in `AuthnLoginController.ts:53,59`, `AuthnMfaController.ts:67`, `AuthnActiveRoleController.ts:73` and `AuthnImpersonationController.ts:87,115`. They are cleared in `AuthnLoginController.ts:41,77`, `AuthnImpersonationController.ts:86,112` and `AuthnSessionsController.ts:61`.
- `AuthnEventType` (`packages/authn/src/contracts/audit.ts:21`). `AuthnAudit` samples only `token.use`/`key.use` (`packages/authn/src/audit/authn-audit.ts:24,116`). The DB audit `type` column is 32 chars (`packages/authn-orm/src/migrations/AuthnInitial_2026_10_02_00_00_00.ts:38`).
- `publishAuthnEvent(container, req, e)` (`packages/authn-http/src/policies/v3/audit.ts:9-15`) imports the `@spinajs/authn` root lazily.
- `req.storage` augmentation: `packages/authn-http/src/api.ts:6-16`. Method-level `@Policy` works (`AuthnActiveRoleController.ts:48-49`). `refused()` shows the `{ error }` body pattern (`packages/authn-http/src/policies/v3/errors.ts:14-16`).
- Unit guard tests: `test/v3/csrf-origin-guard.test.ts` `expectRefused` `:89-93`, `unitGuard` `:95-99`, `fakeReq` `:101-103`, `fakeRes` `:105-108`. The silent-request row `:160-163` expects `E_CSRF_ORIGIN` today.
- The authn schema test pins `http: { csrf: { enabled: true, allowedOrigins: [] } }` (`packages/authn/test/contracts/config-schema.test.ts:289`).
- The v3-app `Client` always sends `Origin: APP_ORIGIN` on non-GET requests (`test/v3-app/app.ts`, `Client.send`). The suites are wired in `test/v3-app/account.test.ts`, and the route list is `ACCOUNT_ROUTES_V3` (`test/v3-app/suites/route-table.ts`).
- Kit: `RULE_IDS` `packages/authn-testing/src/behaviour/types.ts:8`, `routeNames` `:58-82`, `HttpRoutes` `src/harness/http.ts:23-47`, `ConfigOverrides` `authn.http.csrf` `src/harness/config.ts:45`, `ALL` `src/behaviour/index.ts:40`. The registry pins are in `test/registry.test.ts:7,48-53`. v3-app behaviour: `ROUTES` `test/v3-app/behaviour/harness.ts:70-80`, `CLAIM`/`RULES` `behaviour.test.ts:11,13`. `authn.http.csrf` is a supported override (`harness.ts:56`).
- Plan 03 has not been written: `docs/auth-feat/` holds only the README. Task 6 assumes 03's API by name (see there).

## File structure

| File | Responsibility |
|---|---|
| `packages/authn/src/contracts/audit.ts` | `csrf.reject` event type |
| `packages/authn/src/schemas/authn.configuration.ts` | `authn.http.csrf.mode`, `authn.http.csrf.secret` |
| `packages/authn-http/src/middleware/csrf-token.ts` (new) | Pure token functions: mode, key, token, compare, presented token, cookie session id, outcome table, token cookie name and options |
| `packages/authn-http/src/middleware/csrf.ts` | Guard: verdict, outcome, refusal bodies, token cookie follow and refresh, audit; exports shared by the login policy |
| `packages/authn-http/src/api.ts` | `req.storage.CsrfToken` |
| `packages/authn-http/src/v3/controllers/AuthnCsrfController.ts` (new) | `GET /auth/csrf` |
| `packages/authn-http/src/policies/v3/login-origin.ts` (new) | `LoginOriginPolicy` (login CSRF) |
| `packages/authn-testing/src/behaviour/A33-csrf-token.spec.ts` (new) | Behaviour rule A33 |

---

### Task 1: The event type and the schema keys

**Files:**
- Modify: `packages/authn/src/contracts/audit.ts:21`
- Modify: `packages/authn/src/schemas/authn.configuration.ts:373-379`
- Test: `packages/authn/test/contracts/config-schema.test.ts` (`:289` and new cases)

**Interfaces:**
- Produces: `AuthnEventType` includes `'csrf.reject'`. Schema: `authn.http.csrf.mode` (enum, default `'origin-or-token'`) and `authn.http.csrf.secret` (secret ref `{ secret: string(≥32) | null }`).

- [ ] **Step 1: Write the failing tests**

In `packages/authn/test/contracts/config-schema.test.ts`, add `import type { AuthnEventType } from '../../src/contracts/index.js';`. Change the expected `http` of `'fills the security floors inside objects that exist, and nothing else'` (line 289) to:

```ts
        http: { csrf: { enabled: true, allowedOrigins: [], mode: 'origin-or-token' } },
```

Add inside `describe('bad values')`:

```ts
    it('refuses an unknown authn.http.csrf.mode and a short or extra-keyed csrf secret', () => {
      refused({ http: { csrf: { mode: 'token' } } }, '/http/csrf/mode');
      refused({ http: { csrf: { secret: { secret: 'short' } } } }, '/http/csrf/secret/secret');
      refused({ http: { csrf: { secret: { secret: 'x'.repeat(32), value: 'inline' } } } }, '/http/csrf/secret');
    });
```

Add at the end of the top-level describe:

```ts
  it('csrf.reject is an audit event type', () => {
    const type: AuthnEventType = 'csrf.reject';
    expect(type).to.eq('csrf.reject');
  });
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/config-schema.test.ts`
Expected: FAIL at compile time: `Type '"csrf.reject"' is not assignable to type 'AuthnEventType'`.

- [ ] **Step 3: Implement**

In `packages/authn/src/contracts/audit.ts` line 21, append `| 'csrf.reject'` after `'throttle.block'`.

In `packages/authn/src/schemas/authn.configuration.ts`, replace the `csrf` block (lines 373-379):

```ts
        csrf: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', default: true },
            allowedOrigins: { ...stringList, default: [], description: 'Besides the same origin, which is always allowed.' },
            mode: {
              enum: ['origin', 'origin-or-token', 'origin-and-token'],
              default: 'origin-or-token',
              description: "origin: Origin (else Sec-Fetch-Site) decides. origin-or-token: a request with neither passes only with the session's CSRF token. origin-and-token: the own origin and the token. A foreign origin is refused in every mode.",
            },
            secret: {
              ...secretRef('HMAC key of the CSRF token; null: a key derived from http.cookie.secret.'),
              propertyNames: { enum: ['secret'] },
              properties: { secret: { type: ['string', 'null'], minLength: 32 } },
            },
          },
        },
```

- [ ] **Step 4: Run and confirm GREEN, then rebuild**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/contracts/config-schema.test.ts && npm test`
Expected: all passing.

Run: `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/contracts/audit.ts packages/authn/src/schemas/authn.configuration.ts packages/authn/test/contracts/config-schema.test.ts
git diff --cached --stat
git commit -m "feat(authn): csrf.reject audit event, authn.http.csrf.mode and authn.http.csrf.secret in the schema"
```

---

### Task 2: Token functions

**Files:**
- Create: `packages/authn-http/src/middleware/csrf-token.ts`
- Test: `packages/authn-http/test/v3/csrf-token.test.ts` (new)

**Interfaces:**
- Consumes: `sessionHandleOf`, `storageKeyOf`, `sessionCookieName`, `sessionCookieOptions` and the `ISessionCookieConfig` type from `@spinajs/authn-session`.
- Produces (all exported from `csrf-token.ts`):
  - `type CsrfMode = 'origin' | 'origin-or-token' | 'origin-and-token'`; `type OriginVerdict = 'same' | 'foreign' | 'silent'`; `type CsrfOutcome = 'pass' | 'origin' | 'token'`
  - `CSRF_MODES`, `CSRF_HEADER = 'x-csrf-token'`, `CSRF_FORM_FIELD = '_csrf'`, `CSRF_COOKIE_BASE_NAME = 'authn-csrf'`
  - `interface CsrfConfigSource { get<T>(path: string, defaultValue?: T): T }`
  - `csrfMode(config: CsrfConfigSource): CsrfMode`
  - `csrfKey(config: CsrfConfigSource): Buffer`
  - `csrfTokenOf(key: Buffer, rawSessionId: string): string`
  - `csrfTokenMatches(expected: string, presented: unknown): boolean`
  - `presentedToken(req: { readonly headers: Readonly<Record<string, unknown>>; readonly body?: unknown }): string | undefined`
  - `sessionIdOf(req: { readonly cookies?: unknown; readonly signedCookies?: unknown }, names: readonly string[], cookieSecret: string): string | undefined`
  - `csrfOutcome(mode: CsrfMode, verdict: OriginVerdict, tokenOk: boolean): CsrfOutcome`
  - `csrfCookieName(session: ISessionCookieConfig, env: string | undefined): string`
  - `csrfCookieOptions(session: ISessionCookieConfig, env: string | undefined, clear?: boolean): Record<string, unknown>`

- [ ] **Step 1: Write the failing tests**

Create `packages/authn-http/test/v3/csrf-token.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { createHmac } from 'node:crypto';
import * as cs from 'cookie-signature';
import { InvalidOption } from '@spinajs/exceptions';
import { sessionHandleOf, storageKeyOf } from '@spinajs/authn-session';

import { csrfCookieName, csrfCookieOptions, csrfKey, csrfMode, csrfOutcome, csrfTokenMatches, csrfTokenOf, presentedToken, sessionIdOf } from '../../src/middleware/csrf-token.js';
import type { CsrfMode, CsrfOutcome, OriginVerdict } from '../../src/middleware/csrf-token.js';

const COOKIE_SECRET = 'csrf-token-test-cookie-secret';
const configOf = (values: Record<string, unknown>) => ({ get: <T>(path: string, def?: T): T => (path in values ? values[path] : def) as T });
const KEY = csrfKey(configOf({ 'http.cookie.secret': COOKIE_SECRET }));

describe('CSRF token functions', () => {
  it('mode: unset is origin-or-token; the three modes pass; anything else fails naming the key', () => {
    expect(csrfMode(configOf({}))).to.eq('origin-or-token');
    expect(csrfMode(configOf({ 'authn.http.csrf.mode': null }))).to.eq('origin-or-token');
    for (const mode of ['origin', 'origin-or-token', 'origin-and-token']) expect(csrfMode(configOf({ 'authn.http.csrf.mode': mode }))).to.eq(mode);
    for (const mode of ['token', '', 1, true]) expect(() => csrfMode(configOf({ 'authn.http.csrf.mode': mode })), String(mode)).to.throw(InvalidOption, 'authn.http.csrf.mode');
  });

  it('key: authn.http.csrf.secret when set, else derived from http.cookie.secret and never equal to it', () => {
    const own = 'o'.repeat(32);
    expect(csrfKey(configOf({ 'authn.http.csrf.secret.secret': own, 'http.cookie.secret': COOKIE_SECRET })).equals(Buffer.from(own))).to.eq(true);
    expect(KEY.length).to.eq(32);
    expect(KEY.equals(Buffer.from(COOKIE_SECRET))).to.eq(false);
    expect(csrfKey(configOf({ 'http.cookie.secret': COOKIE_SECRET })).equals(KEY), 'stable').to.eq(true);
    expect(() => csrfKey(configOf({ 'authn.http.csrf.secret.secret': 'short' }))).to.throw(InvalidOption, 'authn.http.csrf.secret');
    expect(() => csrfKey(configOf({}))).to.throw(InvalidOption, 'http.cookie.secret');
  });

  it('token: HMAC-SHA256 of the session handle under the key, base64url; per session and per key', () => {
    const expected = createHmac('sha256', KEY).update(`spinajs:authn-http:csrf\0${sessionHandleOf(storageKeyOf('raw-a'))}`).digest('base64url');
    expect(csrfTokenOf(KEY, 'raw-a')).to.eq(expected).and.match(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfTokenOf(KEY, 'raw-b')).to.not.eq(expected);
    expect(csrfTokenOf(Buffer.from('k'.repeat(32)), 'raw-a')).to.not.eq(expected);
  });

  it('compares in constant time and refuses anything but the same string', () => {
    const t = csrfTokenOf(KEY, 'raw-a');
    expect(csrfTokenMatches(t, t)).to.eq(true);
    for (const presented of [csrfTokenOf(KEY, 'raw-b'), t.slice(1), `${t}x`, '', undefined, null, [t], 42]) {
      expect(csrfTokenMatches(t, presented), JSON.stringify(presented)).to.eq(false);
    }
  });

  it('reads X-CSRF-Token first, then a _csrf body field', () => {
    expect(presentedToken({ headers: { 'x-csrf-token': 'h' }, body: { _csrf: 'b' } })).to.eq('h');
    expect(presentedToken({ headers: {}, body: { _csrf: 'b' } })).to.eq('b');
    for (const req of [{ headers: {} }, { headers: { 'x-csrf-token': ['a', 'b'] } }, { headers: {}, body: 'x' }, { headers: {}, body: [{ _csrf: 'b' }] }, { headers: {}, body: { _csrf: 1 } }]) {
      expect(presentedToken(req), JSON.stringify(req)).to.eq(undefined);
    }
  });

  it('reads the raw session id as AuthnMiddleware does: signed by hand, express-signed, first name present wins', () => {
    const names = ['ssid', '__Host-ssid'];
    expect(sessionIdOf({ cookies: { ssid: cs.sign('raw-a', COOKIE_SECRET) } }, names, COOKIE_SECRET)).to.eq('raw-a');
    expect(sessionIdOf({ cookies: {}, signedCookies: { '__Host-ssid': 'raw-b' } }, names, COOKIE_SECRET)).to.eq('raw-b');
    expect(sessionIdOf({ cookies: { ssid: cs.sign('raw-a', COOKIE_SECRET), '__Host-ssid': cs.sign('raw-b', COOKIE_SECRET) } }, names, COOKIE_SECRET)).to.eq('raw-a');
    expect(sessionIdOf({ cookies: { ssid: 'forged' } }, names, COOKIE_SECRET), 'bad signature').to.eq(undefined);
    expect(sessionIdOf({ cookies: { ssid: cs.sign('x'.repeat(129), COOKIE_SECRET) } }, names, COOKIE_SECRET), 'over-long id').to.eq(undefined);
    expect(sessionIdOf({ cookies: { ssid: '' } }, names, COOKIE_SECRET)).to.eq(undefined);
    expect(sessionIdOf({}, names, COOKIE_SECRET)).to.eq(undefined);
  });

  it('decides every mode, verdict and token case', () => {
    const rows: [CsrfMode, OriginVerdict, boolean, CsrfOutcome][] = [
      ['origin', 'same', false, 'pass'],
      ['origin', 'same', true, 'pass'],
      ['origin', 'silent', false, 'origin'],
      ['origin', 'silent', true, 'origin'],
      ['origin', 'foreign', false, 'origin'],
      ['origin', 'foreign', true, 'origin'],
      ['origin-or-token', 'same', false, 'pass'],
      ['origin-or-token', 'same', true, 'pass'],
      ['origin-or-token', 'silent', false, 'token'],
      ['origin-or-token', 'silent', true, 'pass'],
      ['origin-or-token', 'foreign', false, 'origin'],
      ['origin-or-token', 'foreign', true, 'origin'],
      ['origin-and-token', 'same', false, 'token'],
      ['origin-and-token', 'same', true, 'pass'],
      ['origin-and-token', 'silent', false, 'origin'],
      ['origin-and-token', 'silent', true, 'origin'],
      ['origin-and-token', 'foreign', false, 'origin'],
      ['origin-and-token', 'foreign', true, 'origin'],
    ];
    for (const [mode, verdict, tokenOk, outcome] of rows) expect(csrfOutcome(mode, verdict, tokenOk), `${mode} ${verdict} ${tokenOk}`).to.eq(outcome);
  });

  it('the token cookie: the session prefix rule, readable, SameSite=Strict, host-only, cleared with maxAge 0', () => {
    expect(csrfCookieName({}, undefined)).to.eq('__Host-authn-csrf');
    expect(csrfCookieName({}, 'test')).to.eq('authn-csrf');
    expect(csrfCookieName({ name: 'sid', hostPrefix: false }, undefined)).to.eq('authn-csrf');
    const strict = csrfCookieOptions({ domain: 'example.test' }, undefined);
    expect(strict).to.include({ httpOnly: false, secure: true, sameSite: 'strict', path: '/', signed: false });
    expect(strict).to.not.have.property('domain');
    expect(csrfCookieOptions({ domain: 'example.test', hostPrefix: false }, 'test')).to.not.have.property('domain');
    expect(csrfCookieOptions({}, 'test')).to.include({ httpOnly: false, secure: false });
    expect(csrfCookieOptions({}, undefined, true)).to.include({ maxAge: 0 });
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/csrf-token.test.ts`
Expected: FAIL: `Cannot find module '../../src/middleware/csrf-token.js'`.

- [ ] **Step 3: Implement**

Create `packages/authn-http/src/middleware/csrf-token.ts`:

```ts
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import * as cs from 'cookie-signature';
import { InvalidOption } from '@spinajs/exceptions';
import { sessionCookieName, sessionCookieOptions, sessionHandleOf, storageKeyOf } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';

export type CsrfMode = 'origin' | 'origin-or-token' | 'origin-and-token';
/** What the request's Origin (else Sec-Fetch-Site) says: the app or an allowed origin, another site, or nothing. */
export type OriginVerdict = 'same' | 'foreign' | 'silent';
/** 'origin' and 'token' name the missing proof, and so the refusal body. */
export type CsrfOutcome = 'pass' | 'origin' | 'token';

export const CSRF_MODES: readonly CsrfMode[] = ['origin', 'origin-or-token', 'origin-and-token'];
export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_FORM_FIELD = '_csrf';
export const CSRF_COOKIE_BASE_NAME = 'authn-csrf';

const MODE_KEY = 'authn.http.csrf.mode';
const SECRET_KEY = 'authn.http.csrf.secret.secret';
const TOKEN_DOMAIN = 'spinajs:authn-http:csrf\0';
const KEY_INFO = 'spinajs:authn-http:csrf-key';
// authn-session's issuer refuses longer raw ids.
const MAX_RAW_ID_LENGTH = 128;

export interface CsrfConfigSource {
  get<T>(path: string, defaultValue?: T): T;
}

/** Unset is the schema default: a 2.x app never registers the authn schema. */
export function csrfMode(config: CsrfConfigSource): CsrfMode {
  const mode = config.get<unknown>(MODE_KEY);
  if (mode === undefined || mode === null) return 'origin-or-token';
  if (typeof mode !== 'string' || !(CSRF_MODES as readonly string[]).includes(mode)) {
    throw new InvalidOption(`${MODE_KEY} must be one of ${CSRF_MODES.join(', ')}; got ${JSON.stringify(mode)}`);
  }
  return mode as CsrfMode;
}

/** authn.http.csrf.secret, else a key derived from http.cookie.secret (HKDF), so one secret never serves two purposes. */
export function csrfKey(config: CsrfConfigSource): Buffer {
  const own = config.get<unknown>(SECRET_KEY);
  if (own !== undefined && own !== null) {
    if (typeof own !== 'string' || own.length < 32) throw new InvalidOption(`${SECRET_KEY} must be a string of at least 32 characters`);
    return Buffer.from(own, 'utf8');
  }
  const cookieSecret = config.get<unknown>('http.cookie.secret');
  if (typeof cookieSecret !== 'string' || cookieSecret === '') {
    throw new InvalidOption(`neither ${SECRET_KEY} nor http.cookie.secret is set: the CSRF token has no key`);
  }
  return Buffer.from(hkdfSync('sha256', cookieSecret, Buffer.alloc(0), KEY_INFO, 32));
}

/** Bound to the session's one-way handle (AuthnFacts.sessionHandle): a new session id is a new token. */
export function csrfTokenOf(key: Buffer, rawSessionId: string): string {
  return createHmac('sha256', key).update(TOKEN_DOMAIN + sessionHandleOf(storageKeyOf(rawSessionId))).digest('base64url');
}

export function csrfTokenMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** X-CSRF-Token, else the `_csrf` field of a body the parsers already read (urlencoded, JSON; not multipart). */
export function presentedToken(req: { readonly headers: Readonly<Record<string, unknown>>; readonly body?: unknown }): string | undefined {
  const header = req.headers[CSRF_HEADER];
  if (typeof header === 'string') return header;
  const body = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const field = (body as Record<string, unknown>)[CSRF_FORM_FIELD];
  return typeof field === 'string' ? field : undefined;
}

/** The raw session id behind the first of `names` the request carries, read as AuthnMiddleware reads it. */
export function sessionIdOf(req: { readonly cookies?: unknown; readonly signedCookies?: unknown }, names: readonly string[], cookieSecret: string): string | undefined {
  const cookies = (req.cookies ?? {}) as Record<string, unknown>;
  const signed = (req.signedCookies ?? {}) as Record<string, unknown>;
  for (const name of names) {
    const raw = cookies[name];
    const id = typeof raw === 'string' && raw !== '' ? cs.unsign(raw, cookieSecret) : signed[name];
    if (id === undefined) continue;
    return typeof id === 'string' && id !== '' && id.length <= MAX_RAW_ID_LENGTH ? id : undefined;
  }
  return undefined;
}

/** A foreign origin is refused in every mode, token or not: the browser's word beats a token. */
export function csrfOutcome(mode: CsrfMode, verdict: OriginVerdict, tokenOk: boolean): CsrfOutcome {
  if (verdict === 'foreign') return 'origin';
  if (mode === 'origin') return verdict === 'same' ? 'pass' : 'origin';
  if (mode === 'origin-or-token') return verdict === 'same' || tokenOk ? 'pass' : 'token';
  if (verdict === 'silent') return 'origin';
  return tokenOk ? 'pass' : 'token';
}

/** Follows the session cookie's prefix rule: `__Host-authn-csrf` outside development and test. */
export function csrfCookieName(session: ISessionCookieConfig, env: string | undefined): string {
  return sessionCookieName({ ...session, name: CSRF_COOKIE_BASE_NAME }, env);
}

/** Readable by the page's script, which echoes it; host-only whatever Domain the session cookie names. */
export function csrfCookieOptions(session: ISessionCookieConfig, env: string | undefined, clear = false): Record<string, unknown> {
  const options: Record<string, unknown> = { ...sessionCookieOptions({ ...session, name: CSRF_COOKIE_BASE_NAME }, clear ? 0 : undefined, env), httpOnly: false, signed: false };
  delete options.domain;
  return options;
}
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/csrf-token.test.ts`
Expected: PASS, 8 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-http/src/middleware/csrf-token.ts packages/authn-http/test/v3/csrf-token.test.ts
git diff --cached --stat
git commit -m "feat(authn-http): session-bound CSRF token functions"
```

---

### Task 3: The guard verifies tokens, hands them out and audits refusals

**Files:**
- Modify: `packages/authn-http/src/middleware/csrf.ts` (whole file)
- Modify: `packages/authn-http/src/api.ts:14` (storage augmentation)
- Modify: `docs/authn/README.md:624,642`
- Test: `packages/authn-http/test/v3/csrf-origin-guard.test.ts` (`:89-108`, `:160-163`, a new `describe`)

**Interfaces:**
- Consumes: everything from Task 2; `publishAuthnEvent` (`policies/v3/audit.ts`); `appEnvOf`, `SESSION_COOKIE_BASE_NAME`, `sessionHandleOf`, `storageKeyOf` (`@spinajs/authn-session`).
- Produces (exported from `csrf.ts`, used by Task 4):
  - `CSRF_REFUSED_ORIGIN`, `CSRF_REFUSED_TOKEN` (frozen `{ error: { code, message } }`)
  - `allowedOrigins(value: unknown): ReadonlySet<string>`
  - `isCsrfEnabled(config: Configuration): boolean`
  - `originVerdict(req: Request, allowed: ReadonlySet<string>, trust: ProxyTrust): OriginVerdict`
  - `class MinuteBudget { constructor(max: number); take(now?: number): boolean }`
  - `req.storage.CsrfToken?: string | null`

- [ ] **Step 1: Write the failing tests**

In `packages/authn-http/test/v3/csrf-origin-guard.test.ts`:
- Add the imports `import * as cs from 'cookie-signature';` and `import { csrfKey, csrfTokenOf } from '../../src/middleware/csrf-token.js';`, and change the guard import to `import { CSRF_REFUSED_ORIGIN, CSRF_REFUSED_TOKEN, CsrfOriginGuard, ownOrigin } from '../../src/middleware/csrf.js';`.
- Replace `unitGuard` and `fakeRes` (lines 95-108; `fakeReq` stays):

```ts
const UNIT_COOKIE_SECRET = 'unit-cookie-secret';

function unitGuard(values: Record<string, unknown>): CsrfOriginGuard {
  const all: Record<string, unknown> = { 'http.cookie.secret': UNIT_COOKIE_SECRET, ...values };
  const mw = new CsrfOriginGuard();
  Object.defineProperty(mw, 'Configuration', { value: { get: (path: string, def?: unknown) => (path in all ? all[path] : def) } });
  return mw;
}
```

```ts
function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    cookies: [] as unknown[][],
    status: (c: number) => ((res.statusCode = c), res),
    json: (b: unknown) => ((res.body = b), res),
    cookie: (...args: unknown[]) => (res.cookies.push(args), res),
  };
  return res;
}
```

- After `expectRefused` (line 93), add:

```ts
function expectRefusedToken(s: Sent): void {
  expect(s.status, JSON.stringify(s.body)).to.eq(403);
  expect(s.body).to.deep.eq({ error: { code: 'E_CSRF_TOKEN', message: 'CSRF token missing or invalid' } });
  expect(s.ran, 'the refused request never reached the handler').to.eq(false);
}
```

- In `'A22 without Origin, same-site, cross-site, none and absent fetch metadata are refused'` (lines 160-163), change `expectRefused(await send('POST', {}));` to `expectRefusedToken(await send('POST', {}));`. The suite runs the default mode, so a silent request without a token now names the token.
- Append inside `describe('CsrfOriginGuard (A22, SR-12)')`:

```ts
  describe('session-bound token', () => {
    const RAW = 'raw-session-id-for-csrf';
    const signed = (raw: string) => cs.sign(raw, UNIT_COOKIE_SECRET);
    const tokenOf = (raw: string) => csrfTokenOf(csrfKey({ get: <T>(p: string) => (p === 'http.cookie.secret' ? UNIT_COOKIE_SECRET : undefined) as T }), raw);

    function hit(guard: CsrfOriginGuard, method: string, headers: Record<string, string>, opts: { cookies?: Record<string, string>; body?: unknown } = {}) {
      const cookies = opts.cookies ?? { ssid: signed(RAW) };
      const req = { ...fakeReq(method, { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), ...headers }), cookies, body: opts.body };
      const res = fakeRes();
      const next = sinon.spy();
      guard.before()!(req, res as any, next);
      return { passed: next.calledOnce, status: res.statusCode, body: res.body, req, res };
    }

    it('origin-or-token: a request without Origin and fetch metadata passes with the token in X-CSRF-Token or _csrf', () => {
      const guard = unitGuard({});
      expect(hit(guard, 'POST', { 'x-csrf-token': tokenOf(RAW) }).passed).to.eq(true);
      expect(hit(guard, 'POST', {}, { body: { _csrf: tokenOf(RAW) } }).passed).to.eq(true);
    });

    it('origin-or-token: without a valid token it is refused with E_CSRF_TOKEN', () => {
      const guard = unitGuard({});
      for (const [label, r] of [
        ['none', hit(guard, 'POST', {})],
        ['wrong', hit(guard, 'POST', { 'x-csrf-token': tokenOf('another-session') })],
        ['forged cookie', hit(guard, 'POST', { 'x-csrf-token': tokenOf(RAW) }, { cookies: { ssid: 'forged' } })],
      ] as const) {
        expect(r.passed, label).to.eq(false);
        expect(r.body, label).to.deep.eq(CSRF_REFUSED_TOKEN);
      }
    });

    it('a foreign Origin is refused with E_CSRF_ORIGIN in every mode, even with the token', () => {
      for (const mode of ['origin', 'origin-or-token', 'origin-and-token']) {
        const r = hit(unitGuard({ 'authn.http.csrf.mode': mode }), 'POST', { origin: EVIL, 'x-csrf-token': tokenOf(RAW) });
        expect(r.body, mode).to.deep.eq(CSRF_REFUSED_ORIGIN);
      }
    });

    it('origin-and-token: the own origin needs the token, and silence is refused even with it', () => {
      const guard = unitGuard({ 'authn.http.csrf.mode': 'origin-and-token' });
      const own = { host: 'localhost', origin: 'http://localhost' };
      expect(hit(guard, 'POST', own).body).to.deep.eq(CSRF_REFUSED_TOKEN);
      expect(hit(guard, 'POST', { ...own, 'x-csrf-token': tokenOf(RAW) }).passed).to.eq(true);
      expect(hit(guard, 'POST', { 'x-csrf-token': tokenOf(RAW) }).body).to.deep.eq(CSRF_REFUSED_ORIGIN);
    });

    it('origin: tokens are neither checked nor handed out', () => {
      const r = hit(unitGuard({ 'authn.http.csrf.mode': 'origin' }), 'POST', { 'x-csrf-token': tokenOf(RAW) });
      expect(r.body).to.deep.eq(CSRF_REFUSED_ORIGIN);
      expect(r.req.storage.CsrfToken).to.eq(undefined);
      expect(r.res.cookies).to.deep.eq([]);
    });

    it('publishes the token of the session cookie in req.storage.CsrfToken; null without a readable one', () => {
      const guard = unitGuard({});
      expect(hit(guard, 'GET', {}).req.storage.CsrfToken).to.eq(tokenOf(RAW));
      expect(hit(guard, 'GET', {}, { cookies: {} }).req.storage.CsrfToken).to.eq(null);
      expect(hit(guard, 'GET', {}, { cookies: { ssid: 'forged' } }).req.storage.CsrfToken).to.eq(null);
    });

    it('a safe request missing the current token cookie gets it, readable; one holding it gets none', () => {
      const guard = unitGuard({});
      const first = hit(guard, 'GET', {});
      expect(first.res.cookies).to.have.length(1);
      const [name, value, options] = first.res.cookies[0] as [string, string, Record<string, unknown>];
      expect(name).to.eq('__Host-authn-csrf');
      expect(value).to.eq(tokenOf(RAW));
      expect(options).to.include({ httpOnly: false, secure: true, sameSite: 'strict', path: '/' });
      expect(hit(guard, 'GET', {}, { cookies: { ssid: signed(RAW), '__Host-authn-csrf': tokenOf(RAW) } }).res.cookies).to.deep.eq([]);
      expect(hit(guard, 'POST', { 'x-csrf-token': tokenOf(RAW) }).res.cookies, 'only safe requests refresh it').to.deep.eq([]);
    });

    it('each session cookie the response sets brings the token cookie of the new id; a cleared one clears it', () => {
      const r = hit(unitGuard({}), 'POST', { 'x-csrf-token': tokenOf(RAW) });
      const res = r.res as unknown as { cookie: (...a: unknown[]) => unknown; cookies: unknown[][] };
      res.cookie('ssid', signed('rotated'), { signed: false });
      res.cookie('__Host-ssid', 'express-signed', { signed: true });
      res.cookie('other', 'x');
      res.cookie('ssid', '', { maxAge: 0 });
      const set = res.cookies.map(([name, value, options]) => [name, value, (options as Record<string, unknown> | undefined)?.maxAge]);
      expect(set).to.deep.eq([
        ['ssid', signed('rotated'), undefined],
        ['__Host-authn-csrf', tokenOf('rotated'), undefined],
        ['__Host-ssid', 'express-signed', undefined],
        ['__Host-authn-csrf', tokenOf('express-signed'), undefined],
        ['other', 'x', undefined],
        ['ssid', '', 0],
        ['__Host-authn-csrf', '', 0],
      ]);
    });

    it('a bad mode, a short secret or a missing cookie secret fails when the middleware is built, naming the key', () => {
      expect(() => unitGuard({ 'authn.http.csrf.mode': 'token' }).before()).to.throw(InvalidOption, 'authn.http.csrf.mode');
      expect(() => unitGuard({ 'authn.http.csrf.secret.secret': 'short' }).before()).to.throw(InvalidOption, 'authn.http.csrf.secret');
      expect(() => unitGuard({ 'http.cookie.secret': undefined }).before()).to.throw(InvalidOption, 'http.cookie.secret');
      expect(unitGuard({ 'authn.http.csrf.mode': 'origin', 'http.cookie.secret': undefined }).before(), 'mode origin needs no key').to.be.a('function');
    });
  });
```

`EVIL` is the constant at the top of the file. `fakeReq` (line 101) already sets `storage: {}`.

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/csrf-origin-guard.test.ts`
Expected: FAIL at compile time: `Module '"../../src/middleware/csrf.js"' has no exported member 'CSRF_REFUSED_ORIGIN'` (and `CSRF_REFUSED_TOKEN`).

- [ ] **Step 3: Implement**

In `packages/authn-http/src/api.ts`, inside the `IActionLocalStoregeContext` augmentation after `AuthnSession` (line 14), add:

```ts
    /** Written by CsrfOriginGuard: the CSRF token of the request's session cookie, null without a readable one; absent in mode 'origin'. */
    CsrfToken?: string | null;
```

Replace `packages/authn-http/src/middleware/csrf.ts` with:

```ts
import * as cs from 'cookie-signature';
import { Autoinject, Container, DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { HTTP_STATUS_CODE, ServerMiddleware, parseOrigin, requestOrigin } from '@spinajs/http';
import type { ProxyTrust, Request } from '@spinajs/http';
import { SESSION_COOKIE_BASE_NAME, appEnvOf, sessionHandleOf, storageKeyOf } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { Log, Logger } from '@spinajs/log';
import type * as express from 'express';

import { publishAuthnEvent } from '../policies/v3/audit.js';
import { authnProxyTrust } from './client-ip.js';
import { CSRF_COOKIE_BASE_NAME, csrfCookieName, csrfCookieOptions, csrfKey, csrfMode, csrfOutcome, csrfTokenMatches, csrfTokenOf, presentedToken, sessionIdOf } from './csrf-token.js';
import type { CsrfMode, CsrfOutcome, OriginVerdict } from './csrf-token.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_ORIGINS_KEY = 'authn.http.csrf.allowedOrigins';
const AUDIT_PER_MINUTE = 60;

export const CSRF_REFUSED_ORIGIN = Object.freeze({ error: Object.freeze({ code: 'E_CSRF_ORIGIN', message: 'Cross-origin request refused' }) });
export const CSRF_REFUSED_TOKEN = Object.freeze({ error: Object.freeze({ code: 'E_CSRF_TOKEN', message: 'CSRF token missing or invalid' }) });

/**
 * The app's own origin for this request: scheme from the connection and host from Host, or X-Forwarded-Proto and
 * -Host from a trusted proxy only. undefined when they do not make an origin (no Host, or a Host with a path).
 */
export function ownOrigin(req: Parameters<typeof requestOrigin>[0], trust: ProxyTrust): string | undefined {
  return parseOrigin(requestOrigin(req, trust));
}

export function allowedOrigins(value: unknown): ReadonlySet<string> {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value)) throw new InvalidOption(`${ALLOWED_ORIGINS_KEY} must be a list of origins (scheme://host[:port])`);
  return new Set(
    value.map((entry: unknown) => {
      const origin = parseOrigin(entry);
      if (origin === undefined) throw new InvalidOption(`${ALLOWED_ORIGINS_KEY} entry ${JSON.stringify(entry) ?? String(entry)} is not an origin (scheme://host[:port])`);
      return origin;
    }),
  );
}

export function isCsrfEnabled(config: Configuration): boolean {
  const csrf = config.get<unknown>('authn.http.csrf');
  if (csrf !== undefined && csrf !== null && (typeof csrf !== 'object' || Array.isArray(csrf))) {
    throw new InvalidOption('authn.http.csrf must be an object ({ enabled, allowedOrigins, mode, secret })');
  }
  const enabled = config.get<unknown>('authn.http.csrf.enabled');
  if (enabled !== undefined && enabled !== null && typeof enabled !== 'boolean') {
    throw new InvalidOption(`authn.http.csrf.enabled must be true or false; got ${JSON.stringify(enabled)}`);
  }
  return enabled !== false;
}

/** Origin decides when present; without it Sec-Fetch-Site; with neither the browser said nothing. */
export function originVerdict(req: Request, allowed: ReadonlySet<string>, trust: ProxyTrust): OriginVerdict {
  const origin = req.headers.origin;
  if (origin !== undefined) return allowed.has(origin) || origin === ownOrigin(req, trust) ? 'same' : 'foreign';
  const site = req.headers['sec-fetch-site'];
  if (site === undefined) return 'silent';
  return site === 'same-origin' ? 'same' : 'foreign';
}

const WARN_INTERVAL_MS = 60_000;
const WARN_KEYS_MAX = 256;
const WARN_LINES_PER_INTERVAL = 20;
const SHOWN_MAX = 120;

const clip = (v: string): string => (v.length > SHOWN_MAX ? `${v.slice(0, SHOWN_MAX)}…` : v);

/** At most `max` takes a minute: refusals are client-driven, and the audit store must not take a row per forged request. */
export class MinuteBudget {
  private windowStart = 0;
  private used = 0;

  constructor(private readonly max: number) {}

  public take(now = Date.now()): boolean {
    if (now - this.windowStart >= WARN_INTERVAL_MS) {
      this.windowStart = now;
      this.used = 0;
    }
    return this.used++ < this.max;
  }
}

/**
 * At most one warning per (outcome, Origin, own origin) a minute and at most WARN_LINES_PER_INTERVAL lines a minute in
 * all, so requests that vary the headers cannot turn refusals into one log line each.
 */
class RefusalWarnings {
  private readonly last = new Map<string, number>();
  private windowStart = 0;
  private written = 0;

  constructor(private readonly log: () => Log | undefined) {}

  public refused(outcome: CsrfOutcome, origin: string | undefined, fetchSite: unknown, own: string | undefined): void {
    // Request headers are client input: only a well-formed origin is logged, never cookies or tokens.
    const site = typeof fetchSite === 'string' && /^[a-z-]{1,16}$/.test(fetchSite) ? fetchSite : 'absent';
    const shown = origin === undefined ? `none (Sec-Fetch-Site ${site})` : (parseOrigin(origin) ?? 'malformed');
    const key = `${outcome}|${shown}|${own ?? ''}`;
    const now = Date.now();
    const at = this.last.get(key);
    if (at !== undefined && now - at < WARN_INTERVAL_MS) return;
    if (now - this.windowStart >= WARN_INTERVAL_MS) {
      this.windowStart = now;
      this.written = 0;
    }
    if (this.written >= WARN_LINES_PER_INTERVAL) return;
    this.written++;
    if (at === undefined && this.last.size >= WARN_KEYS_MAX) this.last.clear();
    this.last.set(key, now);
    this.log()?.warn(
      outcome === 'token'
        ? `CsrfOriginGuard refused a cookie request without a valid CSRF token: Origin ${clip(shown)}. Send the token of GET /auth/csrf (or of the ${CSRF_COOKIE_BASE_NAME} cookie) in X-CSRF-Token.`
        : `CsrfOriginGuard refused a cookie request: Origin ${clip(shown)}, own origin ${own === undefined ? 'unknown (no usable Host)' : clip(own)}. ` +
            `Behind a proxy set authn.http.trustProxy (or http.trustProxy) so the own origin comes from X-Forwarded-Proto/-Host, or list the origin in ${ALLOWED_ORIGINS_KEY}.`,
    );
  }
}

function carriesCookie(header: string | undefined, names: readonly string[]): boolean {
  return (header ?? '').split(';').some((pair) => names.includes(pair.split('=')[0].trim()));
}

type SetCookie = (name: string, value: unknown, options?: express.CookieOptions) => express.Response;

/** The tokens of one guard: of the request's session cookie, and of every session cookie its response sets. */
class SessionTokens {
  constructor(
    private readonly key: Buffer,
    private readonly sessionCookies: readonly string[],
    private readonly cookieSecret: string,
    private readonly cookieName: string,
    private readonly sessionConfig: ISessionCookieConfig,
    private readonly env: string | undefined,
  ) {}

  public sessionIdOf(req: Request): string | undefined {
    return sessionIdOf(req, this.sessionCookies, this.cookieSecret);
  }

  public tokenOf(rawId: string): string {
    return csrfTokenOf(this.key, rawId);
  }

  /**
   * Publishes `expected` in req.storage.CsrfToken and sets the token cookie on a safe request that lacks the current
   * one. Every session cookie set (http's _setCoockies and express both go through res.cookie) brings the token cookie
   * of the new id, or clears it, so a client never holds the token of an ended session.
   */
  public attach(req: Request, res: express.Response, expected: string | undefined): void {
    req.storage.CsrfToken = expected ?? null;
    const set = res.cookie.bind(res) as SetCookie;
    if (expected !== undefined && SAFE_METHODS.has(req.method) && (req.cookies as Record<string, unknown> | undefined)?.[this.cookieName] !== expected) {
      set(this.cookieName, expected, csrfCookieOptions(this.sessionConfig, this.env));
    }
    res.cookie = ((name: string, value: unknown, options?: express.CookieOptions) => {
      set(name, value, options);
      if (this.sessionCookies.includes(name)) this.follow(set, value, options);
      return res;
    }) as typeof res.cookie;
  }

  private follow(set: SetCookie, value: unknown, options: express.CookieOptions | undefined): void {
    const id = typeof value !== 'string' || value === '' ? undefined : options?.signed === true ? value : cs.unsign(value, this.cookieSecret) || undefined;
    if (id === undefined) set(this.cookieName, '', csrfCookieOptions(this.sessionConfig, this.env, true));
    else set(this.cookieName, this.tokenOf(id), csrfCookieOptions(this.sessionConfig, this.env));
  }
}

/**
 * Order 4, before AuthnMiddleware; off when authn.http.csrf.enabled is false. An unsafe request (any method but GET,
 * HEAD and OPTIONS) carrying the session cookie passes as authn.http.csrf.mode says: Origin (else Sec-Fetch-Site)
 * naming the app or authn.http.csrf.allowedOrigins, the session's CSRF token, or both; else 403 before any controller
 * (A22, A33, SR-12). Requests without the session cookie are not checked here; LoginOriginPolicy guards the login.
 */
@Injectable(ServerMiddleware)
export class CsrfOriginGuard extends ServerMiddleware {
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Autoinject(Container)
  protected Container!: IContainer;

  @Logger('authn-http')
  protected Log!: Log;

  constructor() {
    super();
    this.Order = 4;
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    const enabled = isCsrfEnabled(this.Configuration);
    const allowed = allowedOrigins(this.Configuration.get<unknown>(ALLOWED_ORIGINS_KEY));
    const trust = authnProxyTrust(this.Configuration);
    const mode = csrfMode(this.Configuration);
    if (!enabled) return null;

    // Until AuthnMiddleware replaces the 2.x session code, that code and authn-session can disagree on the
    // __Host- prefix, so both forms count as the session cookie.
    const sessionConfig = this.Configuration.get<ISessionCookieConfig>('authn.session.cookie', {}) ?? {};
    const base = sessionConfig.name ?? SESSION_COOKIE_BASE_NAME;
    const sessionCookies = [base, `__Host-${base}`];
    const tokens = mode === 'origin' ? null : this.tokens(sessionConfig, sessionCookies);
    const warnings = new RefusalWarnings(() => this.Log);
    // Only the 3.0 layer has loaded @spinajs/authn, whose AuthnAudit takes the event; a 2.x app must not load it for this.
    const audit = (DI.getRegisteredTypes(ServerMiddleware) ?? []).some((t) => t.name === 'AuthnMiddleware') ? new MinuteBudget(AUDIT_PER_MINUTE) : null;

    return (req: Request, res: express.Response, next: express.NextFunction) => {
      const rawId = tokens?.sessionIdOf(req);
      const expected = rawId === undefined ? undefined : tokens!.tokenOf(rawId);
      tokens?.attach(req, res, expected);

      if (SAFE_METHODS.has(req.method) || !carriesCookie(req.headers.cookie, sessionCookies)) return next();

      const verdict = originVerdict(req, allowed, trust);
      const outcome = csrfOutcome(mode, verdict, expected !== undefined && csrfTokenMatches(expected, presentedToken(req)));
      if (outcome === 'pass') return next();

      warnings.refused(outcome, req.headers.origin, req.headers['sec-fetch-site'], ownOrigin(req, trust));
      if (audit?.take()) void this.audit(req, mode, outcome, rawId);
      res.status(HTTP_STATUS_CODE.FORBIDDEN).json(outcome === 'origin' ? CSRF_REFUSED_ORIGIN : CSRF_REFUSED_TOKEN);
    };
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return null;
  }

  protected tokens(sessionConfig: ISessionCookieConfig, sessionCookies: readonly string[]): SessionTokens {
    const cookieSecret = this.Configuration.get<unknown>('http.cookie.secret');
    if (typeof cookieSecret !== 'string' || cookieSecret === '') throw new InvalidOption('http.cookie.secret is not set: session cookies, and so CSRF tokens, cannot be read');
    const env = appEnvOf(this.Configuration);
    return new SessionTokens(csrfKey(this.Configuration), sessionCookies, cookieSecret, csrfCookieName(sessionConfig, env), sessionConfig, env);
  }

  protected async audit(req: Request, mode: CsrfMode, outcome: CsrfOutcome, rawId: string | undefined): Promise<void> {
    try {
      await publishAuthnEvent(this.Container, req, {
        type: 'csrf.reject',
        outcome: 'failure',
        reason: outcome,
        data: { mode, method: req.method },
        ...(rawId !== undefined ? { session: sessionHandleOf(storageKeyOf(rawId)) } : {}),
      });
    } catch (e) {
      this.Log.warn(`CsrfOriginGuard could not audit a refusal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
```

`csrfKey` already throws when both secrets are missing. The guard's own cookie-secret check covers an own `authn.http.csrf.secret` that is set without a cookie secret.

In `docs/authn/README.md` (CRLF):
- Line 624: `http: { trustProxy: null, csrf: { enabled: true, allowedOrigins: [], mode: 'origin-or-token', secret: { secret: null } }, routes: { prefix: 'auth' } },`
- Replace the `authn.http.*` row (line 642):

```markdown
| `authn.http.*` | `authn-http` | Trusted proxy and CSRF. `csrf.mode`: `origin` (Origin, else Sec-Fetch-Site), `origin-or-token` (default: a request with neither needs the session's CSRF token), `origin-and-token`. A foreign origin is refused in every mode. Clients take the token from `GET /auth/csrf` or the readable `authn-csrf` cookie and send it in `X-CSRF-Token` (or the form field `_csrf`, not in multipart). `csrf.secret` keys the token; null derives a key from `http.cookie.secret`. Refusals are audited as `csrf.reject`. |
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json test/v3/csrf-origin-guard.test.ts test/v3/csrf-token.test.ts`
Expected: PASS, all passing (the existing A22 cases included).

Run: `cd packages/authn-http && npm test`
Expected: all passing. A 2.x or v3-app case that posts with a session cookie and neither Origin nor Sec-Fetch-Site would now answer `E_CSRF_TOKEN` instead of `E_CSRF_ORIGIN`. Update such an expectation to the new body; do not change the guard.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-http/src/middleware/csrf.ts packages/authn-http/src/api.ts packages/authn-http/test/v3/csrf-origin-guard.test.ts docs/authn/README.md
git diff --cached --stat
git commit -m "feat(authn-http): CsrfOriginGuard checks the session-bound CSRF token by authn.http.csrf.mode, hands it out and audits csrf.reject"
```

---

### Task 4: GET /auth/csrf and login CSRF

**Files:**
- Create: `packages/authn-http/src/v3/controllers/AuthnCsrfController.ts`
- Create: `packages/authn-http/src/policies/v3/login-origin.ts`
- Modify: `packages/authn-http/src/v3/controllers/AuthnLoginController.ts:3,33`
- Modify: `packages/authn-http/src/v3/index.ts` (export `LoginOriginPolicy`)
- Modify: `packages/authn-http/test/v3-app/suites/route-table.ts` (`ACCOUNT_ROUTES_V3`)
- Create: `packages/authn-http/test/v3-app/suites/csrf.ts`
- Modify: `packages/authn-http/test/v3-app/account.test.ts`

**Interfaces:**
- Consumes: `CSRF_REFUSED_ORIGIN`, `MinuteBudget`, `allowedOrigins`, `isCsrfEnabled`, `originVerdict` (Task 3); `csrfCookieName` (Task 2); `req.storage.CsrfToken`.
- Produces: `GET /auth/csrf` → 200 `{ Token: string | null }` with `Cache-Control: no-store`. `LoginOriginPolicy` (a `BasePolicy`) on `POST /auth/login`: a foreign verdict gets 403 with body `error` `{ code: 'E_CSRF_ORIGIN', message: 'Cross-origin request refused' }` and a `csrf.reject` event with reason `login-origin`.

- [ ] **Step 1: Write the failing tests**

Add `'GET /auth/csrf'` to `ACCOUNT_ROUTES_V3` in `packages/authn-http/test/v3-app/suites/route-table.ts`, after `'GET /auth'`.

Create `packages/authn-http/test/v3-app/suites/csrf.ts`:

```ts
import chai, { expect } from 'chai';
import { appEnvOf } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import type { AuthnEvent } from '@spinajs/authn/contracts';

import { csrfCookieName } from '../../../src/middleware/csrf-token.js';
import { AUTHN_PROBE_PATH } from '../../v3/probe.js';
import { APP_ORIGIN, Client, config, cookieName, events, guard, loggedIn, loggedInAal2, resetRecorders, roles, seedUser, step, throttle } from '../app.js';
import type { Res } from '../app.js';

const EVIL = 'https://evil.example.net';
const PROBE = `/${AUTHN_PROBE_PATH}`;

const tokenCookieName = (): string => csrfCookieName(config().get<ISessionCookieConfig>('authn.session.cookie', {}) ?? {}, appEnvOf(config()));

/** The token cookie a response sets: its value and lower-cased attributes. */
function tokenSetCookie(res: Res): { value: string; attrs: Map<string, string> } | undefined {
  const raw = res.setCookie.find((c) => c.startsWith(`${tokenCookieName()}=`));
  if (!raw) return undefined;
  const [pair, ...rest] = raw.split(';').map((p) => p.trim());
  const attrs = new Map<string, string>();
  for (const a of rest) {
    const i = a.indexOf('=');
    attrs.set((i < 0 ? a : a.slice(0, i)).toLowerCase(), i < 0 ? '' : a.slice(i + 1));
  }
  return { value: decodeURIComponent(pair.slice(pair.indexOf('=') + 1)), attrs };
}

const tokenOf = async (c: Client): Promise<string | null> => (await c.get('/auth/csrf')).body.Token;

/** An unsafe request as a client whose Origin and Sec-Fetch-Site a proxy stripped (the Client always adds Origin). */
async function bare(c: Client | null, method: 'POST' | 'DELETE', path: string, headers: Record<string, string> = {}, body?: object): Promise<Res> {
  const agent = chai.request(APP_ORIGIN);
  let call = (method === 'POST' ? agent.post(path) : agent.delete(path)).set('Accept', 'application/json');
  if (c?.cookie) call = call.set('Cookie', `${cookieName()}=${encodeURIComponent(c.cookie)}`);
  for (const [k, v] of Object.entries(headers)) call = call.set(k, v);
  const res = body === undefined ? await call : await call.send(body);
  return { status: res.status, body: res.body, text: res.text, headers: res.header, setCookie: ([] as string[]).concat(res.header['set-cookie'] ?? []) };
}

/** The guard audits without holding the answer; bounded by count, not time. */
async function rejections(n: number): Promise<readonly AuthnEvent[]> {
  for (let i = 0; i < 100 && events.ofType('csrf.reject').length < n; i++) await new Promise((r) => setTimeout(r, 5));
  return events.ofType('csrf.reject');
}

async function expectRotated(c: Client, oldToken: string | null, res: Res, label: string): Promise<string> {
  expect(res.status, `${label}: ${JSON.stringify(res.body)}`).to.eq(200);
  const ck = tokenSetCookie(res);
  expect(ck, `${label} sets the token cookie: ${res.setCookie.join(' | ')}`).to.not.eq(undefined);
  expect(ck!.value, `${label} rotates the token`).to.not.eq(oldToken);
  expect(await tokenOf(c), `${label}: GET /auth/csrf agrees`).to.eq(ck!.value);
  if (oldToken) expect((await bare(c, 'POST', PROBE, { 'X-CSRF-Token': oldToken })).status, `${label}: the old token is refused`).to.eq(403);
  return ck!.value;
}

export function csrfSuite(): void {
  beforeEach(resetRecorders);

  describe('GET /auth/csrf', () => {
    it('answers null, no-store, without a session', async () => {
      const res = await new Client().get('/auth/csrf');
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ Token: null });
      expect(res.headers['cache-control']).to.eq('no-store');
    });

    it('login sets the readable token cookie of the new session: __Host-, Secure, SameSite=Strict, no HttpOnly, no Domain; GET /auth/csrf answers the same token', async () => {
      const u = await seedUser();
      const c = new Client();
      const res = await c.post('/auth/login', { login: u.login, password: u.password });
      expect(tokenCookieName()).to.eq('__Host-authn-csrf');
      const ck = tokenSetCookie(res)!;
      expect(ck, res.setCookie.join(' | ')).to.not.eq(undefined);
      expect([...ck.attrs.keys()]).to.include.members(['secure', 'path', 'samesite']);
      expect(ck.attrs.get('samesite')?.toLowerCase()).to.eq('strict');
      expect([...ck.attrs.keys()]).to.not.include.members(['httponly', 'domain']);
      expect(await tokenOf(c)).to.eq(ck.value);
    });
  });

  describe('origin-or-token (the default)', () => {
    it('a cookie request without Origin and fetch metadata passes with the token, in X-CSRF-Token or _csrf', async () => {
      const c = await loggedIn(await seedUser());
      const token = (await tokenOf(c))!;
      expect((await bare(c, 'POST', PROBE, { 'X-CSRF-Token': token })).status).to.eq(200);
      expect((await bare(c, 'POST', PROBE, {}, { _csrf: token })).status).to.eq(200);
    });

    it('without the token, or with a wrong one, it is refused 403 E_CSRF_TOKEN and audited as csrf.reject with the hashed session', async () => {
      const c = await loggedIn(await seedUser());
      for (const headers of [{}, { 'X-CSRF-Token': 'x'.repeat(43) }]) {
        const res = await bare(c, 'POST', PROBE, headers);
        expect(res.status).to.eq(403);
        expect(res.body).to.deep.eq({ error: { code: 'E_CSRF_TOKEN', message: 'CSRF token missing or invalid' } });
      }
      const rejected = await rejections(2);
      expect(rejected).to.have.length(2);
      expect(rejected[0]).to.include({ outcome: 'failure', reason: 'token' });
      expect(rejected[0].data).to.deep.eq({ mode: 'origin-or-token', method: 'POST' });
      expect(rejected[0].session).to.be.a('string').and.not.eq(c.sessionId);
    });

    it('the token of another session is refused', async () => {
      const a = await loggedIn(await seedUser());
      const b = await loggedIn(await seedUser());
      expect((await bare(a, 'POST', PROBE, { 'X-CSRF-Token': (await tokenOf(b))! })).status).to.eq(403);
    });

    it('a foreign Origin is refused 403 E_CSRF_ORIGIN even with the token', async () => {
      const c = await loggedIn(await seedUser());
      const res = await bare(c, 'POST', PROBE, { Origin: EVIL, 'X-CSRF-Token': (await tokenOf(c))! });
      expect(res.status).to.eq(403);
      expect(res.body.error.code).to.eq('E_CSRF_ORIGIN');
    });
  });

  describe('the token follows the session', () => {
    it('MFA completion', async () => {
      const u = await seedUser();
      step.enrol(u.ref);
      const c = await loggedIn(u);
      await expectRotated(c, await tokenOf(c), await c.post('/auth/mfa/verify', { code: step.nextCode(u.ref) }), 'mfa verify');
    });

    it('a role switch', async () => {
      const u = await seedUser();
      await roles.grant(u.ref, [{ role: 'editor', requirePassword: false }]);
      const c = await loggedIn(u);
      await expectRotated(c, await tokenOf(c), await c.post('/auth/active-role', { role: 'editor' }), 'role switch');
    });

    it('impersonation start and stop', async () => {
      await guard.allowAll();
      const admin = await seedUser();
      const target = await seedUser();
      const c = await loggedInAal2(admin);
      const started = await expectRotated(c, await tokenOf(c), await c.post('/auth/impersonate', { target: target.ref.id }), 'impersonation start');
      await expectRotated(c, started, await c.del('/auth/impersonate'), 'impersonation stop');
    });

    it('logout clears the token cookie', async () => {
      const c = await loggedIn(await seedUser());
      const ck = tokenSetCookie(await c.post('/auth/logout'))!;
      expect(ck.value).to.eq('');
      expect(ck.attrs.get('max-age')).to.eq('0');
    });
  });

  describe('login CSRF', () => {
    it('a login from a foreign Origin or cross-site fetch metadata is refused 403 before any authentication, and audited', async () => {
      const u = await seedUser();
      for (const headers of [{ Origin: EVIL }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        const res = await bare(null, 'POST', '/auth/login', headers, { login: u.login, password: u.password });
        expect(res.status, JSON.stringify(headers)).to.eq(403);
        expect(res.body.error).to.deep.eq({ code: 'E_CSRF_ORIGIN', message: 'Cross-origin request refused' });
        expect(res.setCookie.some((s) => s.startsWith(`${cookieName()}=`)), 'no session cookie').to.eq(false);
      }
      expect(throttle.attempts.filter((a) => a.flow === 'login')).to.have.length(0);
      expect((await rejections(2)).map((e) => e.reason)).to.deep.eq(['login-origin', 'login-origin']);
    });

    it('a login with neither Origin nor fetch metadata passes (non-browser clients)', async () => {
      const u = await seedUser();
      expect((await bare(null, 'POST', '/auth/login', {}, { login: u.login, password: u.password })).status).to.eq(200);
    });
  });
}
```

In `packages/authn-http/test/v3-app/account.test.ts`, add `import { csrfSuite } from './suites/csrf.js';` and, after `describe('impersonation', impersonationSuite);`:

```ts
    describe('CSRF token (A33)', csrfSuite);
```

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json test/v3-app/account.test.ts`
Expected: FAIL. `GET /auth/csrf` answers 404 (`expected 404 to equal 200`). The route table misses `GET /auth/csrf`. The `login CSRF` refusal case gets 200. The guard cases pass already (Task 3), except those that read `GET /auth/csrf`.

- [ ] **Step 3: Implement**

Create `packages/authn-http/src/v3/controllers/AuthnCsrfController.ts`:

```ts
import { BaseController, BasePath, Get, Ok, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import { NO_STORE } from '../responses.js';

/**
 * The CSRF token of the caller's session cookie, for a client that cannot read the token cookie (an allowed
 * cross-origin page). Fetch it again after any answer that sets the session cookie.
 * @tags Authentication
 */
@BasePath('auth')
export class AuthnCsrfController extends BaseController {
  /**
   * CSRF token
   * `{ Token }` to send in X-CSRF-Token with unsafe requests; null without a session cookie or in csrf mode `origin`.
   * @security []
   */
  @Get('csrf')
  public async token(@Req() req: Request) {
    return new Ok({ Token: req.storage.CsrfToken ?? null }, { Headers: [NO_STORE] });
  }
}
```

Create `packages/authn-http/src/policies/v3/login-origin.ts`:

```ts
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Forbidden } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';

import { authnProxyTrust } from '../../middleware/client-ip.js';
import { CSRF_REFUSED_ORIGIN, MinuteBudget, allowedOrigins, isCsrfEnabled, originVerdict } from '../../middleware/csrf.js';
import { publishAuthnEvent } from './audit.js';

const AUDIT_PER_MINUTE = 60;

/**
 * Login CSRF: a login carries no session cookie, so CsrfOriginGuard lets it through, and a foreign page could log the
 * browser into the attacker's account. Refuses a login whose Origin (else Sec-Fetch-Site) names another site; one that
 * sends neither passes, as native and CLI clients do. Off with authn.http.csrf.enabled false.
 */
export class LoginOriginPolicy extends BasePolicy {
  @Autoinject(Configuration)
  protected Configuration!: Configuration;

  @Autoinject(Container)
  protected Container!: IContainer;

  protected readonly Budget = new MinuteBudget(AUDIT_PER_MINUTE);

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (!isCsrfEnabled(this.Configuration)) return;
    const allowed = allowedOrigins(this.Configuration.get<unknown>('authn.http.csrf.allowedOrigins'));
    if (originVerdict(req, allowed, authnProxyTrust(this.Configuration)) !== 'foreign') return;
    if (this.Budget.take()) await publishAuthnEvent(this.Container, req, { type: 'csrf.reject', outcome: 'failure', reason: 'login-origin', data: { method: req.method } });
    throw Object.assign(new Forbidden(CSRF_REFUSED_ORIGIN.error.message), { error: { ...CSRF_REFUSED_ORIGIN.error } });
  }
}
```

In `packages/authn-http/src/v3/controllers/AuthnLoginController.ts`:
- line 3: `import { BaseController, BasePath, Get, Ok, Policy, Post, Req } from '@spinajs/http';`
- add `import { LoginOriginPolicy } from '../../policies/v3/login-origin.js';` after the `fresh-auth.js` import.
- under `@Post('login')` (line 33) add `@Policy(LoginOriginPolicy)`.
- add a sentence to the login doc comment (lines 26-31), before `@security []`: `A login whose Origin (or Sec-Fetch-Site) names another site gets 403 E_CSRF_ORIGIN (login CSRF).`

In `packages/authn-http/src/v3/index.ts`, after the `CsrfOriginGuard` export (line 13) add:

```ts
export { LoginOriginPolicy } from '../policies/v3/login-origin.js';
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json test/v3-app/account.test.ts`
Expected: PASS, all suites, the CSRF ones included.

Run: `cd packages/authn-http && npm test`
Expected: all passing. `test/v3/route-table-n8c.test.ts` stays green, because `GET /auth/csrf` has no 2.x twin.

Run: `cd packages/authn-http && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-http/src/v3/controllers/AuthnCsrfController.ts packages/authn-http/src/policies/v3/login-origin.ts packages/authn-http/src/v3/controllers/AuthnLoginController.ts packages/authn-http/src/v3/index.ts packages/authn-http/test/v3-app/suites/route-table.ts packages/authn-http/test/v3-app/suites/csrf.ts packages/authn-http/test/v3-app/account.test.ts
git diff --cached --stat
git commit -m "feat(authn-http): GET /auth/csrf, and LoginOriginPolicy against login CSRF"
```

---

### Task 5: Behaviour rule A33

**Files:**
- Create: `packages/authn-testing/src/behaviour/A33-csrf-token.spec.ts`
- Modify: `packages/authn-testing/src/behaviour/types.ts:8,58-82`
- Modify: `packages/authn-testing/src/behaviour/index.ts` (import, `ALL` at `:40`)
- Modify: `packages/authn-testing/src/harness/http.ts:23-47`, `packages/authn-testing/src/harness/config.ts:45`
- Modify: `packages/authn-testing/test/registry.test.ts:7,48-53`
- Modify: `packages/authn-http/test/v3-app/behaviour/harness.ts:70-80`, `packages/authn-http/test/v3-app/behaviour/behaviour.test.ts:11,13`

**Interfaces:**
- Consumes: `GET /auth/csrf` and `LoginOriginPolicy` (Task 4); the kit's `send`, `sendRaw`, `routes`, `seedUser`, `ALICE`, `BOB`, `ORIGIN_EVIL`.
- Produces: `HttpRoutes.csrf(): HttpRequest`; rule `A33` with facet `A33/http`; `ConfigOverrides` `authn.http.csrf.mode`.

- [ ] **Step 1: Write the rule (the failing test)**

In `packages/authn-testing/src/harness/http.ts`, add to `HttpRoutes` after `sessionsList(): HttpRequest;`:

```ts
  /** GET the session's CSRF token: body `{ Token: string | null }`. */
  csrf(): HttpRequest;
```

In `packages/authn-testing/src/behaviour/types.ts`, append `'A33'` to `RULE_IDS` (line 8) and add `csrf: 1,` to `routeNames` after `sessionsList: 1,`.

In `packages/authn-testing/src/harness/config.ts` line 45, change the `csrf` member to `csrf: { enabled: boolean; allowedOrigins: readonly string[]; mode: 'origin' | 'origin-or-token' | 'origin-and-token' }`.

Create `packages/authn-testing/src/behaviour/A33-csrf-token.spec.ts`:

```ts
import assert from 'node:assert/strict';
import type { ConfigOverrides } from '../harness/config.js';
import type { HttpResponse } from '../harness/http.js';
import type { CookieJar } from '../helpers/cookies.js';
import { ALICE, BOB, ORIGIN_EVIL, routes, seedUser, send, sendRaw } from './steps.js';
import type { KitUser } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule, CaseKit, HarnessWith, Need } from './types.js';

type TokenHarness = HarnessWith<'http' | 'seed' | 'http.routes.login' | 'http.routes.csrf'>;

const NEEDS: readonly Need[] = ['http', 'http.routes.login', 'http.routes.csrf', 'seed'];
const AND: ConfigOverrides = { authn: { http: { csrf: { mode: 'origin-and-token' } } } };

/** `u` logged in through `send` (own Origin), and its session's token from the csrf route. */
async function withToken(h: TokenHarness, k: CaseKit, u: KitUser, jar: CookieJar = k.jar()): Promise<{ jar: CookieJar; token: string }> {
  await seedUser(h, u);
  const res = await send(h, routes(h).login(u.login, u.password), jar);
  assert.strictEqual(res.status, 200, `login answered ${res.status}`);
  const token = ((await send(h, routes(h).csrf(), jar)).body as { Token?: unknown } | undefined)?.Token;
  assert.ok(typeof token === 'string' && token !== '', `the csrf route answered ${JSON.stringify(token)}`);
  return { jar, token };
}

/** A cookie POST to the probe with exactly `headers`: no Origin is added. */
const post = (h: TokenHarness, jar: CookieJar, headers: Record<string, string>): Promise<HttpResponse> => sendRaw(h, { method: 'POST', path: h.http.probePath, headers }, jar);

export const A33: AuthnRule = defineRule('A33', 'a cookie request can prove its origin with the session-bound CSRF token', [
  defineCase({
    name: 'A33 without Origin and fetch metadata a cookie request passes with its session token',
    facet: 'A33/http',
    needs: [...NEEDS],
    async run(h, k) {
      const { jar, token } = await withToken(h as TokenHarness, k, ALICE);
      assert.strictEqual((await post(h as TokenHarness, jar, { 'x-csrf-token': token })).status, 200);
    },
  }),
  defineCase({
    name: 'A33 without Origin and fetch metadata a cookie request without a valid token is refused',
    facet: 'A33/http',
    needs: [...NEEDS],
    async run(h, k) {
      const { jar, token } = await withToken(h as TokenHarness, k, ALICE);
      assert.strictEqual((await post(h as TokenHarness, jar, {})).status, 403);
      assert.strictEqual((await post(h as TokenHarness, jar, { 'x-csrf-token': 'x'.repeat(token.length) })).status, 403);
    },
  }),
  defineCase({
    name: 'A33 the token of another session is refused',
    facet: 'A33/http',
    needs: [...NEEDS],
    async run(h, k) {
      const alice = await withToken(h as TokenHarness, k, ALICE);
      const bob = await withToken(h as TokenHarness, k, BOB);
      assert.strictEqual((await post(h as TokenHarness, alice.jar, { 'x-csrf-token': bob.token })).status, 403);
    },
  }),
  defineCase({
    name: 'A33 a new session gets a new token and the old one is refused',
    facet: 'A33/http',
    needs: [...NEEDS],
    async run(h, k) {
      const first = await withToken(h as TokenHarness, k, ALICE);
      const second = await withToken(h as TokenHarness, k, ALICE, first.jar);
      assert.notStrictEqual(second.token, first.token);
      assert.strictEqual((await post(h as TokenHarness, first.jar, { 'x-csrf-token': first.token })).status, 403);
      assert.strictEqual((await post(h as TokenHarness, first.jar, { 'x-csrf-token': second.token })).status, 200);
    },
  }),
  defineCase({
    name: 'A33 a foreign Origin is refused even with the session token',
    facet: 'A33/http',
    needs: [...NEEDS],
    async run(h, k) {
      const { jar, token } = await withToken(h as TokenHarness, k, ALICE);
      assert.strictEqual((await post(h as TokenHarness, jar, { origin: ORIGIN_EVIL, 'x-csrf-token': token })).status, 403);
    },
  }),
  defineCase({
    name: 'A33 origin-and-token: the own Origin needs the token too',
    facet: 'A33/http',
    needs: [...NEEDS],
    config: AND,
    async run(h, k) {
      const { jar, token } = await withToken(h as TokenHarness, k, ALICE);
      assert.strictEqual((await post(h as TokenHarness, jar, { origin: h.http!.origin })).status, 403);
      assert.strictEqual((await post(h as TokenHarness, jar, { origin: h.http!.origin, 'x-csrf-token': token })).status, 200);
    },
  }),
  defineCase({
    name: 'A33 login CSRF: a login from a foreign Origin is refused and sets no session cookie',
    facet: 'A33/http',
    needs: [...NEEDS],
    async run(h, k) {
      const th = h as TokenHarness;
      await seedUser(th, ALICE);
      const jar = k.jar();
      const res = await sendRaw(th, { ...routes(th).login(ALICE.login, ALICE.password), headers: { origin: ORIGIN_EVIL } }, jar);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(jar.get(th.http.sessionCookie), undefined);
    },
  }),
  defineCase({
    name: 'A33 a refusal is audited as csrf.reject',
    facet: 'A33/http',
    needs: [...NEEDS, 'events'],
    async run(h, k) {
      const th = h as TokenHarness & HarnessWith<'events'>;
      const { jar } = await withToken(th, k, ALICE);
      th.events.clear();
      assert.strictEqual((await post(th, jar, {})).status, 403);
      // The guard audits without holding the answer: bounded by count, not time.
      for (let i = 0; i < 100 && !th.events.all().some((e) => e.type === 'csrf.reject'); i++) await new Promise((r) => setTimeout(r, 5));
      const e = th.events.all().find((x) => x.type === 'csrf.reject');
      assert.ok(e, 'a csrf.reject event');
      assert.strictEqual(e.outcome, 'failure');
    },
  }),
]);
```

Before writing the file, check how `A22-csrf.spec.ts` and `A21-audit.spec.ts` type `h` inside `run`. If `defineCase` already narrows `h` from `needs`, drop the casts. Also check whether `Need` is exported from `./types.js` or from `../harness/ports.js`, and import it from there.

In `packages/authn-testing/src/behaviour/index.ts`, add `import { A33 } from './A33-csrf-token.spec.js';` after the A32 import, and append `A33` to `ALL`.

In `packages/authn-testing/test/registry.test.ts`:
- line 7: append `'A33/http'` to `FACET_MAP`.
- lines 48-53:

```ts
  it('RULE_IDS are A01–A27 and A30–A33 in order', () => {
    const expected = [...Array.from({ length: 27 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`), 'A30', 'A31', 'A32', 'A33'];
    assert.deepStrictEqual([...RULE_IDS], expected);
    assert.deepStrictEqual([...AUTHN_RULES.keys()], expected);
    assert.strictEqual(AUTHN_RULES.has('A28' as RuleId), false);
    assert.strictEqual(AUTHN_RULES.has('A29' as RuleId), false);
  });
```

In `packages/authn-http/test/v3-app/behaviour/harness.ts`, add to `ROUTES` after `sessionsList`:

```ts
  csrf: () => ({ method: 'GET', path: '/auth/csrf' }),
```

In `packages/authn-http/test/v3-app/behaviour/behaviour.test.ts`, append `'A33/http'` to `CLAIM` (line 11) and `'A33'` to `RULES` (line 13).

- [ ] **Step 2: Run the kit's own tests**

Run: `cd packages/authn-testing && npx ts-mocha -p tsconfig.json test/registry.test.ts && npm test`
Expected: PASS. A33 runs nowhere in this package: its harnesses have no `csrf` route, so its cases are pending, not failing.

- [ ] **Step 3: Rebuild the kit and run A33 over the app**

Run: `cd packages/authn-testing && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`
Run: `cd packages/authn-http && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json test/v3-app/behaviour/behaviour.test.ts`
Expected: PASS. The plan-list check still names only the four expected pending cases, and the eight A33 cases pass. To prove the rule bites, temporarily change `csrfOutcome`'s `origin-or-token` line to `return 'pass';` and rerun: the refusal cases must fail. Then revert the change.

- [ ] **Step 4: Commit**

```bash
git add packages/authn-testing/src/behaviour/A33-csrf-token.spec.ts packages/authn-testing/src/behaviour/types.ts packages/authn-testing/src/behaviour/index.ts packages/authn-testing/src/harness/http.ts packages/authn-testing/src/harness/config.ts packages/authn-testing/test/registry.test.ts packages/authn-http/test/v3-app/behaviour/harness.ts packages/authn-http/test/v3-app/behaviour/behaviour.test.ts
git diff --cached --stat
git commit -m "test(authn-testing): A33 session-bound CSRF token, claimed by the authn-http 3.0 app"
```

---

### Task 6: Message IDs for the CSRF refusals (only after plan 03 has landed)

Skip this task until plan 03 is merged. Until then the bodies keep `code` only, as Tasks 3-4 left them.

**Assumed plan 03 API.** Plan 03 is not written yet, so these names are assumptions. If 03 ships other names, use 03's names, and keep the IDs and texts below, which are binding.
- `packages/authn/src/messages/catalogue.ts` exports `AUTHN_MESSAGES`, a frozen record keyed by message name, of `AuthnMessage { readonly id: number; readonly type: 'info' | 'error'; readonly text: string }`. It is exported from the subpath `@spinajs/authn/messages`, which must not load the `@spinajs/authn` root (authn-http's guard runs in 2.x apps).
- A refusal body carries the id as `error.id`.

**Files:**
- Modify: `packages/authn/src/messages/catalogue.ts`
- Modify: `packages/authn-http/src/middleware/csrf.ts` (`CSRF_REFUSED_ORIGIN`, `CSRF_REFUSED_TOKEN`)
- Test: `packages/authn/test/messages/catalogue.test.ts` (03's catalogue test), `packages/authn-http/test/v3/csrf-origin-guard.test.ts`

**Interfaces:**
- Produces: `AUTHN_MESSAGES.csrfOriginRefused` = `{ id: 4002001, type: 'error', text: 'Cross-origin request refused' }` and `AUTHN_MESSAGES.csrfTokenRefused` = `{ id: 4002002, type: 'error', text: 'CSRF token missing or invalid' }`.

- [ ] **Step 1: Write the failing tests**

In 03's catalogue test, add:

```ts
  it('04: the CSRF refusals are 4002001 and 4002002', () => {
    expect(AUTHN_MESSAGES.csrfOriginRefused).to.deep.eq({ id: 4002001, type: 'error', text: 'Cross-origin request refused' });
    expect(AUTHN_MESSAGES.csrfTokenRefused).to.deep.eq({ id: 4002002, type: 'error', text: 'CSRF token missing or invalid' });
  });
```

In `packages/authn-http/test/v3/csrf-origin-guard.test.ts`, change the body in `expectRefused` to `{ error: { code: 'E_CSRF_ORIGIN', message: 'Cross-origin request refused', id: 4002001 } }`, and in `expectRefusedToken` to `{ error: { code: 'E_CSRF_TOKEN', message: 'CSRF token missing or invalid', id: 4002002 } }`.

- [ ] **Step 2: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/messages/catalogue.test.ts`
Expected: FAIL: `Property 'csrfOriginRefused' does not exist`.

- [ ] **Step 3: Implement**

In `packages/authn/src/messages/catalogue.ts`, add to `AUTHN_MESSAGES` in 03's style, inside the 4002xxx block:

```ts
  csrfOriginRefused: { id: 4002001, type: 'error', text: 'Cross-origin request refused' },
  csrfTokenRefused: { id: 4002002, type: 'error', text: 'CSRF token missing or invalid' },
```

Rebuild authn. In `packages/authn-http/src/middleware/csrf.ts`, add `import { AUTHN_MESSAGES } from '@spinajs/authn/messages';` and replace the two constants:

```ts
const refusal = (code: string, m: { readonly id: number; readonly text: string }) => Object.freeze({ error: Object.freeze({ code, message: m.text, id: m.id }) });

export const CSRF_REFUSED_ORIGIN = refusal('E_CSRF_ORIGIN', AUTHN_MESSAGES.csrfOriginRefused);
export const CSRF_REFUSED_TOKEN = refusal('E_CSRF_TOKEN', AUTHN_MESSAGES.csrfTokenRefused);
```

`LoginOriginPolicy` spreads `CSRF_REFUSED_ORIGIN.error`, so its body gains the id too.

- [ ] **Step 4: Run and confirm GREEN**

Run: `cd packages/authn && npm test && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`, then `cd packages/authn-http && npm test`
Expected: all passing. The v3-app login CSRF case compares `res.body.error` with `deep.eq`, so add `id: 4002001` there too.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/messages/catalogue.ts packages/authn/test/messages/catalogue.test.ts packages/authn-http/src/middleware/csrf.ts packages/authn-http/test/v3/csrf-origin-guard.test.ts packages/authn-http/test/v3-app/suites/csrf.ts
git diff --cached --stat
git commit -m "feat(authn, authn-http): message IDs 4002001 and 4002002 for the CSRF refusals"
```

---

## Self-review

- **Spec coverage.** The session-bound HMAC token is Task 2. The secret decision (own secret ref, else derived from the cookie secret) is Decision 2 and `csrfKey`. Delivery through `GET /auth/csrf` (3.0) and a readable cookie is Tasks 3-4. `X-CSRF-Token` and `_csrf` are `presentedToken`. The mode config and its default are Task 1 and Decision 3. Rotation on login, MFA, role switch and impersonation is Decision 1, tested in the Task 4 suite and in A33. The constant-time compare is `csrfTokenMatches`. The `csrf.reject` audit is Tasks 1, 3 and 4. Message range 4002xxx and the dependency on 03 are Task 6, and the body keeps its code without 03. Login CSRF is Decision 7 and Task 4. The A-series row is Task 5.
- **Placeholder scan.** Task 6 depends on an API that does not exist yet. It names every assumed symbol and states what is binding (IDs and texts). One instruction in Task 5 Step 1 ("check how A22 types `h`; drop the casts if `defineCase` narrows it") covers a typing detail that cannot be read without running the compiler. Both forms are given.
- **Type consistency.** `CsrfMode`, `OriginVerdict`, `CsrfOutcome`, `csrfTokenOf`, `csrfKey`, `csrfCookieName`, `csrfCookieOptions`, `sessionIdOf` and `presentedToken` (Task 2) are used with the same signatures in Tasks 3-5. `CSRF_REFUSED_ORIGIN`/`CSRF_REFUSED_TOKEN`, `MinuteBudget`, `allowedOrigins`, `isCsrfEnabled` and `originVerdict` (Task 3) are what Task 4 imports. `req.storage.CsrfToken` is written in Task 3 and read in Task 4.
