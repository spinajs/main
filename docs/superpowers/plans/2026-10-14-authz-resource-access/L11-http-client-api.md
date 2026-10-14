# Lane L11: http client API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` in this folder first: its Global Constraints, Decisions and Frozen contracts bind this lane.

**Goal:** Give `@spinajs/authz-http` the client half of design §10: `POST /user/access/checks` (replacing `POST /user/access/check`), the `X-Access-Epoch` header, the SSE push transport behind `GET /user/access/events`, and `format=tree` on the explain route.

**Architecture:** A new folder `packages/authz-http/src/client-access/` holds three small units: `epoch.ts` (a `ServerMiddleware`, Order 11), `checks.ts` (pure parsing of the ckit wire format and the evaluation through `AuthzService.checkAll`), `sse.ts` (`SseAccessPushTransport implements AccessPushTransport`, plus the `Response` subclass that hands the express response to it). `AccessController` keeps `GET /user/access` and gains the two new routes. `explain/tree.ts` maps `Decision.trace` to `{ label, allowed, children }`.

**Tech Stack:** TypeScript (node16), `@spinajs/http` (express 5), `@spinajs/di`, mocha + ts-mocha + chai 4 + chai-http, raw `node:http` for the stream tests.

**Depends on:** L0 merged (`AccessPushTransport`, `AccessChangedEvent`, `AuthzService.checkAll` abstract). L2 Task 3 + Task 5 merged for Task 2 of this lane (`DefaultAuthzService.checkAll`: input order; an unregistered permission or a type the permission cannot be checked on is a denied Decision with `reason.code: 'invalid_request'`, a malformed entry still throws; second pass loads rows with `loadMany`/`load`, a missing row denies `unknown_resource`, no loader leaves the decision conditional). L2 Task 8 (`AccessChangeRouter`, resolves `Array.chainOf(AccessPushTransport)` from the root container per change) feeds the transport in an app (this lane's tests call `push()` directly); Task 3 needs L2 Task 8 merged only for `AUTHZ_CHANGED_EVENT`. Tasks 1 and 4 need only L0.

**Blocks:** L9 (end-to-end client conformance, `runClientAccessConformance`).

## Global Constraints

- All code, comments, identifiers and commit messages in English; comments only where a reader would ask "why?".
- Match the surrounding code: `@Injectable(Token)` / `@Singleton()`, `Object.freeze` where a value is shared, `InvalidArgument` (400) for a malformed request, `@Logger('authz-http')`.
- Tests: mocha + chai `expect`, `test/<name>.test.ts`, the existing harness `test/support/app.ts` (`startApp`, `stopApp`), `test/support/principals.ts` (`registerHeaderSource`: `x-user: <id>` → `user:<id>`), `test/support/domain.ts` (`createDomain`).
- One file: `cd packages/authz-http && npx ts-mocha -p tsconfig.json test/<name>.test.ts` (run `npm run compile` in `packages/authz` first after L0/L2 changes; the harness imports the built `@spinajs/authz`).
- `packages/authz-http/src/api.ts` is the only snapshotted file of this package. This lane does not touch it, so no snapshot update and no RFC. If an implementer moves anything into `api.ts`, they must run `npm run build`, `node scripts/api-snapshot.mjs --update` and add `docs/plans/authz-v3-rfc/RA11-1.md` in the same commit.
- Commit after every task.

## Decisions made in this lane

1. **Reason codes of `/checks`.** `reasons[i]` is the decision's `reason.code` for a deny (`invalid_request` from `checkAll` for an unregistered permission or a type the permission cannot be checked on), else one of these codes set by the endpoint: `invalid_request` (malformed entry, the same code `checkAll` uses), `subject_mismatch`, `conditional` (allowed with a residual that loading the row did not settle), `field_denied` (`context.field` outside `decision.fields[fieldMode]`). `null` only for `true`.
2. **Per-entry isolation (overview decision 14).** `checkAll` denies an unregistered permission or an uncheckable type with `invalid_request` and throws only on a malformed entry. The endpoint validates each entry's shape itself (`object` a record with non-empty string `type` and `id`, `permission` a non-empty string that forms a valid permission name, `subject`, `context`) and answers a malformed one `false` + `invalid_request` without sending it; every other entry goes to one `checkAll` call. There is no entry-by-entry retry: a throw from `checkAll` after that validation is a server fault (500).
3. **400 only for the body.** A body whose `checks` is not an array, or holds more than `MAX_ACCESS_CHECKS` (100) entries, is a 400. An empty list answers `{ results: [], reasons: [] }`.
4. **Field narrowing** uses `decisionFields(authz, decision)` (the decision's sets minus `authz.fields.neverRead`) and `compileFieldGlobs(...).allows(field)`, the same sets `@Access` routes enforce, so `'*'` and nested globs behave identically. Other `context` keys are ignored, never mapped into `env`.
5. **Subject.** Absent, or `{ type, id }` equal to the request principal's, without `relation`. Anything else is `subject_mismatch` (a userset subject included).
6. **SSE writes through a `Response` subclass.** `@spinajs/http` sends `res.locals.response` after the action (`packages/http/src/response.ts:15-33`); an action returning `undefined` becomes a 404 there. `AccessEventStream extends Response` overrides `execute(req, res)` to hand `res` to the transport and send nothing itself, as `Redirect` does (`packages/http/src/response-methods/redirect.ts`).
7. **SSE and compression.** `@spinajs/http` registers the `compression` middleware twice (the `Compression` ServerMiddleware, Order 0, and `compression()` in `http.middlewares`, `packages/http/src/config/http.ts:116`), and `text/event-stream` is compressible, so compression would buffer frames. `Cache-Control: no-cache, no-transform` makes `compression` skip the response (`shouldTransform`, `node_modules/compression/index.js:293-300`); `X-Accel-Buffering: no` stops nginx buffering; `res.flushHeaders()` sends the headers at once.
8. **SSE close.** The transport forgets a stream on `res` `'close'` (fires on a client disconnect and on our own `end()`). On `http.server.closing` (emitted by `HttpServer._close`) it ends every open stream, otherwise `server.close()` waits for the 10 s shutdown watchdog.
9. **Push keys.** A stream (and the socket room in L13) is registered under `principalKey(principal)` and the key of each `principal.companions` entry, so a link bearer's stream also hears changes of the signed-in user behind it.
10. **Epoch.** `sha256(principalKey(p) + (p.authn?.sessionHandle ?? '') + ceilingHash(p.ceiling))`, first 16 hex characters (overview decision 5), set in `before()` of a `ServerMiddleware` with Order 11. A response without a principal carries no header. The response that rotates the session (login, role switch) still carries the epoch of the principal the request started with; the next response carries the new one.
11. **Explain tree mapping** (design §10.6), exact:
    - root: `label = "<resourceKey(resource)>#<permission> = <verdict>"`, `verdict` = `allow` (allowed with a `TRUE` residual), `conditional` (allowed with another residual), `deny (<reason.code ?? 'no_access'>)`; `allowed` = definite allow.
    - one child per `trace.votes[i]` in order: `label = "<model>: <vote verdict>"` with vote verdict `error (<error>)` when `error` is set, else `deny[ (<reason.code>)]` when `denyWhen` is `TRUE`, else `permit` when `permitWhen` is `TRUE` and `denyWhen` is `FALSE`, else `abstain[ (<reason.code>)]` when both are `FALSE`, else `conditional`; `allowed` = the vote verdict is `permit`; children = the vote's `trace` steps.
    - a last child for the engine: `label = "<algorithm> over [<models joined by ', '>] in <domain>"`, `allowed` = root's, children = `trace.steps`.
    - a step: `label = "<by> <step>: <note>"`, `allowed` = its parent's `allowed`, `children: []`; `data` and `durationMs` are dropped.
    - a decision without a trace: `children: []`.

## Files

- Create: `packages/authz-http/src/client-access/epoch.ts`, `checks.ts`, `sse.ts`, `index.ts`
- Create: `packages/authz-http/src/explain/tree.ts`
- Modify: `packages/authz-http/src/controllers/AccessController.ts` (whole file)
- Modify: `packages/authz-http/src/explain/controller.ts:57-68` (`format` query), `src/explain/index.ts`
- Modify: `packages/authz-http/src/index.ts:9` (export `client-access`)
- Modify: `packages/authz-http/src/config/authz-http.ts:26`, `src/http-config.ts:33` (doc comments naming the old route)
- Modify: `packages/authz-http/README.md`, `docs/authz/README.md:509-511`, `docs/authz/migration-guide.md:359`
- Tests: `test/access-epoch.test.ts` (new), `test/access-controller.test.ts` (rewritten), `test/fixtures/ckit-http-checker.ts` (new), `test/access-events.test.ts` (new), `test/explain-tree.test.ts` (new), `test/explain.test.ts` (one case added)

---

### Task 1: `X-Access-Epoch`

**Files:**
- Create: `packages/authz-http/src/client-access/epoch.ts`, `packages/authz-http/src/client-access/index.ts`
- Modify: `packages/authz-http/src/index.ts`
- Test: `packages/authz-http/test/access-epoch.test.ts`

**Interfaces:**
- Consumes: `principalKey`, `ceilingHash` from `@spinajs/authz`; `PRINCIPAL_MIDDLEWARE_ORDER` (`src/principals/middleware.ts:24`).
- Produces: `ACCESS_EPOCH_HEADER = 'X-Access-Epoch'`, `ACCESS_EPOCH_MIDDLEWARE_ORDER = 11`, `accessEpoch(principal: Principal): string`, `class AccessEpochMiddleware extends ServerMiddleware`.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-http/test/access-epoch.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { testHost, userPrincipal } from '@spinajs/authz-testing';

import { ANONYMOUS, HasPrincipal, PrincipalSource, accessEpoch } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';

const authn = (sessionHandle: string) => ({ method: 'password', strategy: 'local', assurance: 'aal1' as const, mfa: [], authenticatedAt: new Date(0), sessionHandle });

/** `x-user` names the user, `x-session` its session handle, `x-ceiling` one ceiling permission. */
class EpochHeaderSource extends PrincipalSource {
  public readonly name = 'test-epoch';
  public readonly order = 0;

  public async authenticate(req: Request): Promise<Principal | null> {
    const id = req.headers['x-user'];
    if (typeof id !== 'string' || id === '') return null;
    const session = req.headers['x-session'];
    const ceiling = req.headers['x-ceiling'];
    return userPrincipal(id, { ...(typeof session === 'string' ? { authn: authn(session) } : {}), ...(typeof ceiling === 'string' ? { ceiling: { permissions: [ceiling] } } : {}) });
  }
}

@BasePath('epoch')
class EpochProbeController extends BaseController {
  @Get('/')
  @Policy(HasPrincipal)
  public probe() {
    return new Ok({ ok: true });
  }
}

describe('X-Access-Epoch', function () {
  this.timeout(30000);

  describe('accessEpoch', () => {
    it('is 16 hex characters, stable for one principal', () => {
      const epoch = accessEpoch(userPrincipal('alice', { authn: authn('s1') }));
      expect(epoch).to.match(/^[0-9a-f]{16}$/);
      expect(accessEpoch(userPrincipal('alice', { authn: authn('s1') }))).to.eq(epoch);
    });

    it('changes with the principal, the session handle and the ceiling', () => {
      const base = accessEpoch(userPrincipal('alice', { authn: authn('s1') }));
      expect(accessEpoch(userPrincipal('bob', { authn: authn('s1') }))).to.not.eq(base);
      expect(accessEpoch(userPrincipal('alice', { authn: authn('s2') }))).to.not.eq(base);
      expect(accessEpoch(userPrincipal('alice', { authn: authn('s1'), ceiling: { permissions: ['file:read'] } }))).to.not.eq(base);
    });
  });

  describe('on responses', () => {
    let app: TestApp;

    before(async () => {
      DI.register(EpochHeaderSource).as(PrincipalSource);
      app = await startApp({ controllers: [EpochProbeController] });
    });

    after(async () => {
      await stopApp();
      DI.unregister(EpochHeaderSource);
      DI.uncache(EpochHeaderSource);
      DI.uncache(PrincipalSource);
    });

    it("carries the epoch of the request's principal", async () => {
      const res = await app.request().get('/epoch').set('x-user', 'alice').set('x-session', 's1');

      expect(res.status).to.eq(200);
      expect(res.header['x-access-epoch']).to.eq(accessEpoch(userPrincipal('alice', { authn: authn('s1') })));
    });

    it('changes when the session rotates or the ceiling changes, not otherwise', async () => {
      const epoch = async (headers: Record<string, string>) => {
        let r = app.request().get('/epoch');
        for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
        return (await r).header['x-access-epoch'] as string;
      };

      const first = await epoch({ 'x-user': 'alice', 'x-session': 's1' });
      expect(await epoch({ 'x-user': 'alice', 'x-session': 's1' })).to.eq(first);
      expect(await epoch({ 'x-user': 'alice', 'x-session': 's2' })).to.not.eq(first);
      expect(await epoch({ 'x-user': 'alice', 'x-session': 's1', 'x-ceiling': 'file:read' })).to.not.eq(first);
    });

    it('gives the anonymous principal its epoch and leaves a request without a principal without one', async () => {
      const anonymous = await app.request().get('/epoch');
      expect(anonymous.header['x-access-epoch']).to.eq(accessEpoch(ANONYMOUS));

      testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], false);
      try {
        const none = await app.request().get('/epoch');
        expect(none.status).to.eq(401);
        expect(none.header).to.not.have.property('x-access-epoch');
      } finally {
        testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], true);
      }
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-http && npx ts-mocha -p tsconfig.json test/access-epoch.test.ts`
Expected: FAIL with a TSError `Module '"../src/index.js"' has no exported member 'accessEpoch'`.

- [ ] **Step 3: Write the middleware**

Create `packages/authz-http/src/client-access/epoch.ts`:

```ts
import { createHash } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { ceilingHash, principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { ServerMiddleware } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type * as express from 'express';

import { PRINCIPAL_MIDDLEWARE_ORDER } from '../principals/middleware.js';
import '../storage.js';

export const ACCESS_EPOCH_HEADER = 'X-Access-Epoch';

export const ACCESS_EPOCH_MIDDLEWARE_ORDER = PRINCIPAL_MIDDLEWARE_ORDER + 1;

/**
 * Changes when the principal's access may change while no authz data does (design §10.4): login, role
 * switch, MFA elevation and impersonation all rotate the session, which changes `authn.sessionHandle`.
 */
export function accessEpoch(principal: Principal): string {
  return createHash('sha256')
    .update(principalKey(principal) + (principal.authn?.sessionHandle ?? '') + ceilingHash(principal.ceiling))
    .digest('hex')
    .slice(0, 16);
}

@Injectable(ServerMiddleware)
export class AccessEpochMiddleware extends ServerMiddleware {
  constructor() {
    super();
    this.Order = ACCESS_EPOCH_MIDDLEWARE_ORDER;
  }

  // In before(): after() never runs for a matched controller route.
  public before(): (req: Request, res: express.Response, next: express.NextFunction) => void {
    return (req, res, next) => {
      const principal = req.storage.Principal;
      if (principal) res.setHeader(ACCESS_EPOCH_HEADER, accessEpoch(principal));
      next();
    };
  }

  public after(): null {
    return null;
  }
}
```

Create `packages/authz-http/src/client-access/index.ts`:

```ts
export * from './epoch.js';
```

In `packages/authz-http/src/index.ts`, after line 9 (`export * from './swagger.js';`) add:

```ts
export * from './client-access/index.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz-http && npx ts-mocha -p tsconfig.json test/access-epoch.test.ts`
Expected: PASS, `5 passing`, `0 failing`.

- [ ] **Step 5: Run the package suite for regressions**

Run: `cd packages/authz-http && npm test`
Expected: `0 failing`.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-http/src/client-access packages/authz-http/src/index.ts packages/authz-http/test/access-epoch.test.ts
git commit -m "feat(authz-http): X-Access-Epoch header from principal, session handle and ceiling"
```

---

### Task 2: `POST /user/access/checks` replaces `POST /user/access/check`

**Files:**
- Create: `packages/authz-http/src/client-access/checks.ts`
- Modify: `packages/authz-http/src/client-access/index.ts`
- Modify: `packages/authz-http/src/controllers/AccessController.ts` (whole file)
- Create: `packages/authz-http/test/fixtures/ckit-http-checker.ts`
- Rewrite: `packages/authz-http/test/access-controller.test.ts`

**Interfaces:**
- Consumes: `AuthzService.checkAll(principal, requests: readonly { permission; resource }[]): Promise<readonly Decision[]>` (L2 Task 5; an `invalid_request` decision for an unregistered permission or uncheckable type, throws only on a malformed entry); `decisionFields(authz, decision)` (`src/fields.ts:30`); `compileFieldGlobs`, `isPermission`, `GLOBAL` from `@spinajs/authz`.
- Produces: `MAX_ACCESS_CHECKS = 100` (moved here from `AccessController.ts`), `CLIENT_CHECK_REASONS`, `interface ClientChecksAnswer { results: boolean[]; reasons: (string | null)[] }`, `readClientCheck(raw, principal): ClientCheck | string`, `answerClientChecks(service, principal, raw, opts: { authz: unknown; log: Log }): Promise<ClientChecksAnswer>`; route `POST /user/access/checks` (`HasPrincipal`).

- [ ] **Step 1: Add the ckit fixture**

Create `packages/authz-http/test/fixtures/ckit-http-checker.ts`:

```ts
/**
 * The body ckit's createHttpChecker puts on the wire (its default `encodeChecks`, then
 * `JSON.stringify`) for the requests of coderush/ckit `packages/access/src/http.test.ts`,
 * "createHttpChecker: the default exchange > posts the checks as JSON and returns the answers in
 * request order". Keep it byte for byte: it is the compatibility contract (design §10.7).
 */
export const CKIT_DEFAULT_EXCHANGE_BODY =
  '{"checks":[{"object":{"type":"doc","id":"1"},"permission":"edit","subject":{"type":"user","id":"me"}},{"object":{"type":"doc","id":"2"},"permission":"view","subject":{"type":"user","id":"me"},"context":{"ip":"10.0.0.1"}},{"object":{"type":"doc","id":"3"},"permission":"edit","subject":{"type":"user","id":"me"}}]}';

/** That test's fake backend allows odd ids, which the domain of access-controller.test.ts mirrors. */
export const CKIT_DEFAULT_EXCHANGE_RESULTS: readonly boolean[] = [true, false, true];
```

- [ ] **Step 2: Rewrite the controller test**

Replace `packages/authz-http/test/access-controller.test.ts` with:

```ts
import 'mocha';
import { expect } from 'chai';
import { TRUE } from '@spinajs/authz';
import type { DecisionRequest } from '@spinajs/authz';
import { FakeRbacModel, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { ScriptedVote } from '@spinajs/authz-testing';

import { AccessController, MAX_ACCESS_CHECKS } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { createDomain } from './support/domain.js';
import type { TestDomain } from './support/domain.js';
import { registerHeaderSource } from './support/principals.js';
import { CKIT_DEFAULT_EXCHANGE_BODY, CKIT_DEFAULT_EXCHANGE_RESULTS } from './fixtures/ckit-http-checker.js';

const D = 'acs';

const odd = (req: DecisionRequest) => req.resource.id !== undefined && Number(req.resource.id) % 2 === 1;

// m1: doc:edit and doc:view on odd ids (doc:edit writes only `title`), doc:create at type level,
// doc:archive only on a row condition, report:export at GLOBAL.
const votes = (req: DecisionRequest): ScriptedVote => {
  switch (req.permission) {
    case 'doc:edit':
      return odd(req) ? { permitWhen: TRUE, fields: { read: ['*'], write: ['title'] } } : {};
    case 'doc:view':
      return odd(req) ? { permitWhen: TRUE } : {};
    case 'doc:create':
      return req.resource.id === undefined ? { permitWhen: TRUE } : {};
    case 'doc:archive':
      return { permitWhen: { op: 'cmp', field: 'status', cmp: 'eq', value: 'open' } };
    case 'report:export':
      return req.resource.type === '$global' ? { permitWhen: TRUE } : {};
    default:
      return {};
  }
};

const PERMISSIONS = { 'file:read': {}, 'file:write': {}, 'file:delete': {}, 'doc:edit': { fields: true }, 'doc:view': {}, 'doc:create': {}, 'doc:archive': {}, 'report:export': {} };

describe('AccessController (B25, design §10.2)', function () {
  this.timeout(30000);

  let app: TestApp;
  let domain: TestDomain;
  let unregisterSource: () => void;

  before(async () => {
    unregisterSource = registerHeaderSource();
    app = await startApp({ controllers: [AccessController] });
    testHost.config().set(['authz', 'http', 'access'], { domain: D });
    const rbac = new FakeRbacModel({
      name: 'rbac',
      roles: { editor: ['file:read', { permission: 'file:write', relation: 'owner' }] },
      assignments: [{ subject: userPrincipal('alice'), role: 'editor' }],
    });
    domain = await createDomain(D, { permissions: PERMISSIONS, model: { votes, capabilities: { fields: true } }, extraModel: rbac });
  });

  after(async () => {
    testHost.config().unset(['authz', 'http', 'access']);
    await domain?.dispose();
    await stopApp();
    unregisterSource();
  });

  const withoutAnonymous = async (fn: () => Promise<void>) => {
    testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], false);
    try {
      await fn();
    } finally {
      testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], true);
    }
  };

  describe('GET /user/access', () => {
    it('returns the principal, its roles and GLOBAL permissions with conditional', async () => {
      const res = await app.request().get('/user/access').set('x-user', 'alice');

      expect(res.status).to.eq(200);
      expect(res.body.principal).to.deep.eq({ type: 'user', id: 'alice' });
      expect(res.body.models.find((m: { model: string }) => m.model === 'rbac').roles).to.deep.include({ role: 'editor', scope: { type: '$global' } });
      expect(res.body.permissions).to.deep.include({ name: 'file:read', conditional: false });
      expect(res.body.permissions).to.deep.include({ name: 'file:write', conditional: true });
      expect(res.body.permissions.map((p: { name: string }) => p.name)).to.not.include('file:delete');
    });

    it('answers an anonymous request with the anonymous principal', async () => {
      const res = await app.request().get('/user/access');

      expect(res.status).to.eq(200);
      expect(res.body.principal).to.deep.include({ type: 'anonymous' });
    });

    it('answers 401 without a principal', async () => {
      await withoutAnonymous(async () => {
        expect((await app.request().get('/user/access')).status).to.eq(401);
      });
    });
  });

  describe('POST /user/access/checks', () => {
    const post = (body: unknown, user: string | null = 'alice') => {
      let r = app.request().post('/user/access/checks');
      if (user !== null) r = r.set('x-user', user);
      return r.send(body as object);
    };
    const doc = (id: string, permission: string, extra: Record<string, unknown> = {}) => ({ object: { type: 'doc', id }, permission, ...extra });

    it('answers one boolean and one reason per entry, in request order', async () => {
      const res = await post({ checks: [doc('1', 'edit'), doc('2', 'edit'), doc('3', 'doc:edit')] });

      expect(res.status).to.eq(200);
      expect(res.body.results).to.deep.eq([true, false, true]);
      expect(res.body.reasons[0]).to.eq(null);
      expect(res.body.reasons[1]).to.be.a('string');
      expect(res.body.reasons[2]).to.eq(null);
    });

    it('uses a name with a colon as it is and prefixes a bare action with the object type', async () => {
      const res = await post({ checks: [{ object: { type: 'file', id: 'f1' }, permission: 'read' }, { object: { type: 'file', id: 'f1' }, permission: 'file:read' }] });

      expect(res.body.results).to.deep.eq([true, true]);
    });

    it("reads id '*' as the type-level ref and type '$global' as GLOBAL", async () => {
      const res = await post({ checks: [doc('*', 'create'), doc('7', 'create'), { object: { type: '$global', id: '*' }, permission: 'report:export' }, { object: { type: 'report', id: '*' }, permission: 'export' }] });

      expect(res.body.results).to.deep.eq([true, false, true, false]);
    });

    it('answers a conditional decision false', async () => {
      const res = await post({ checks: [doc('1', 'archive')] });

      expect(res.body.results).to.deep.eq([false]);
      expect(res.body.reasons).to.deep.eq(['conditional']);
    });

    it('answers subject_mismatch for any subject but the caller', async () => {
      const res = await post({
        checks: [doc('1', 'edit', { subject: { type: 'user', id: 'alice' } }), doc('1', 'edit', { subject: { type: 'user', id: 'bob' } }), doc('1', 'edit', { subject: { type: 'team', id: 'eng', relation: 'member' } })],
      });

      expect(res.body.results).to.deep.eq([true, false, false]);
      expect(res.body.reasons).to.deep.eq([null, 'subject_mismatch', 'subject_mismatch']);
    });

    it('narrows to decision.fields with context.field, write by default, and ignores other context keys', async () => {
      const res = await post({
        checks: [doc('1', 'edit', { context: { field: 'title' } }), doc('1', 'edit', { context: { field: 'amount' } }), doc('1', 'edit', { context: { field: 'amount', fieldMode: 'read' } }), doc('1', 'edit', { context: { ip: '10.0.0.1' } })],
      });

      expect(res.body.results).to.deep.eq([true, false, true, true]);
      expect(res.body.reasons).to.deep.eq([null, 'field_denied', null, null]);
    });

    it('isolates malformed entries, unknown permissions and uncheckable types', async () => {
      const res = await post({
        checks: [
          'nonsense',
          { object: { type: 'doc' }, permission: 'edit' },
          doc('1', 'bad name'),
          doc('1', 'edit', { context: { field: '' } }),
          { object: { type: 'ghost', id: '1' }, permission: 'read' },
          { object: { type: 'file', id: 'f1' }, permission: 'doc:edit' },
          doc('1', 'edit'),
        ],
      });

      expect(res.status).to.eq(200);
      expect(res.body.results).to.deep.eq([false, false, false, false, false, false, true]);
      expect(res.body.reasons).to.deep.eq(['invalid_request', 'invalid_request', 'invalid_request', 'invalid_request', 'invalid_request', 'invalid_request', null]);
    });

    it('answers an empty list with empty lists', async () => {
      const res = await post({ checks: [] });

      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ results: [], reasons: [] });
    });

    it(`refuses a body that is not a list, or holds more than ${MAX_ACCESS_CHECKS} entries, with 400`, async () => {
      expect((await post({})).status).to.eq(400);
      expect((await post({ checks: 'x' })).status).to.eq(400);
      expect((await post({ checks: Array.from({ length: MAX_ACCESS_CHECKS + 1 }, () => doc('1', 'edit')) })).status).to.eq(400);

      const full = await post({ checks: Array.from({ length: MAX_ACCESS_CHECKS }, () => doc('1', 'edit')) });
      expect(full.status).to.eq(200);
      expect(full.body.results).to.have.length(MAX_ACCESS_CHECKS);
    });

    it('lets an anonymous caller ask, and answers 401 without a principal', async () => {
      const anonymous = await post({ checks: [doc('1', 'edit')] }, null);
      expect(anonymous.status).to.eq(200);
      expect(anonymous.body.results).to.have.length(1);

      await withoutAnonymous(async () => {
        expect((await post({ checks: [doc('1', 'edit')] }, null)).status).to.eq(401);
      });
    });

    it('carries X-Access-Epoch', async () => {
      const res = await post({ checks: [doc('1', 'edit')] });
      expect(res.header['x-access-epoch']).to.match(/^[0-9a-f]{16}$/);
    });

    it('is the only check route: POST /user/access/check is gone', async () => {
      expect((await app.request().post('/user/access/check').set('x-user', 'alice').send({ checks: [] })).status).to.eq(404);
    });
  });

  describe("ckit's createHttpChecker", () => {
    it('gets one boolean per check for the body it sends, byte for byte', async () => {
      const res = await app.request().post('/user/access/checks').set('content-type', 'application/json').set('accept', 'application/json').set('x-user', 'me').send(CKIT_DEFAULT_EXCHANGE_BODY);

      expect(res.status).to.eq(200);
      const checks = (JSON.parse(CKIT_DEFAULT_EXCHANGE_BODY) as { checks: unknown[] }).checks;
      // ckit's decodeResults: { results: boolean[] } with one entry per check, nothing else read
      expect(Array.isArray(res.body.results)).to.eq(true);
      expect(res.body.results).to.have.length(checks.length);
      expect(res.body.results.every((r: unknown) => typeof r === 'boolean')).to.eq(true);
      expect(res.body.results).to.deep.eq(CKIT_DEFAULT_EXCHANGE_RESULTS);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/authz-http && npx ts-mocha -p tsconfig.json test/access-controller.test.ts`
Expected: FAIL; the `GET /user/access` cases pass, every `POST /user/access/checks` case fails with `expected 404 to equal 200` (or a missing `results`), and the old-route case fails with `expected 400 to equal 404` (the old route refuses an empty list).

- [ ] **Step 4: Write the checks module**

Create `packages/authz-http/src/client-access/checks.ts`:

```ts
import { GLOBAL, compileFieldGlobs, isPermission } from '@spinajs/authz';
import type { AuthzService, Decision, Permission, Principal, ResourceRef } from '@spinajs/authz';
import type { Log } from '@spinajs/log';

import { decisionFields } from '../fields.js';

export const MAX_ACCESS_CHECKS = 100;

/** `reasons[i]` codes the endpoint sets itself; a denial carries the decision's own `reason.code`. */
export const CLIENT_CHECK_REASONS = Object.freeze({
  invalid: 'invalid_request',
  subjectMismatch: 'subject_mismatch',
  conditional: 'conditional',
  fieldDenied: 'field_denied',
} as const);

export interface ClientChecksAnswer {
  readonly results: boolean[];
  readonly reasons: (string | null)[];
}

export interface ClientCheck {
  readonly permission: Permission;
  readonly resource: ResourceRef;
  readonly field?: { readonly name: string; readonly mode: 'read' | 'write' };
}

export interface ClientCheckOptions {
  /** The `authz` config section; `decisionFields` reads `fields.neverRead` from it. */
  readonly authz: unknown;
  readonly log: Log;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

const isCaller = (subject: unknown, principal: Principal): boolean => isRecord(subject) && subject.type === principal.type && subject.id === principal.id && subject.relation === undefined;

/** One `checks[]` entry (ckit's `{ object, permission, subject?, context? }`) as a check, or the reason it is answered false. `checkAll` throws on a malformed entry, so none may reach it. */
export function readClientCheck(raw: unknown, principal: Principal): ClientCheck | string {
  if (!isRecord(raw) || !isRecord(raw.object) || !nonEmpty(raw.object.type) || !nonEmpty(raw.object.id) || !nonEmpty(raw.permission)) return CLIENT_CHECK_REASONS.invalid;
  const type = raw.object.type;
  const id = raw.object.id;
  const permission = raw.permission.includes(':') ? raw.permission : `${type}:${raw.permission}`;
  if (!isPermission(permission)) return CLIENT_CHECK_REASONS.invalid;
  if (raw.subject !== undefined && !isCaller(raw.subject, principal)) return CLIENT_CHECK_REASONS.subjectMismatch;

  let field: ClientCheck['field'];
  if (raw.context !== undefined) {
    if (!isRecord(raw.context)) return CLIENT_CHECK_REASONS.invalid;
    const { field: name, fieldMode } = raw.context;
    if (name !== undefined) {
      if (!nonEmpty(name) || (fieldMode !== undefined && fieldMode !== 'read' && fieldMode !== 'write')) return CLIENT_CHECK_REASONS.invalid;
      field = { name, mode: fieldMode ?? 'write' };
    }
  }

  const resource: ResourceRef = type === GLOBAL.type ? GLOBAL : id === '*' ? { type } : { type, id };
  return field ? { permission, resource, field } : { permission, resource };
}

function verdict(d: Decision, check: ClientCheck, authz: unknown): [boolean, string | null] {
  if (!d.allowed) return [false, d.reason?.code ?? 'no_access'];
  if (d.residual.op !== 'true') return [false, CLIENT_CHECK_REASONS.conditional];
  if (check.field && !compileFieldGlobs(decisionFields(authz, d)[check.field.mode]).allows(check.field.name)) return [false, CLIENT_CHECK_REASONS.fieldDenied];
  return [true, null];
}

/** Design §10.2: only a definite allow is true; a bad entry costs its own answer, never the batch. */
export async function answerClientChecks(service: AuthzService, principal: Principal, raw: readonly unknown[], opts: ClientCheckOptions): Promise<ClientChecksAnswer> {
  const parsed = raw.map((entry) => readClientCheck(entry, principal));
  const results = parsed.map(() => false);
  const reasons = parsed.map((p): string | null => (typeof p === 'string' ? p : null));
  parsed.forEach((p, i) => {
    if (typeof p === 'string') opts.log.debug(`POST /user/access/checks: entry ${i} answered false (${p})`);
  });

  const pending = parsed.flatMap((p, i) => (typeof p === 'string' ? [] : [{ i, check: p }]));
  const decisions = pending.length === 0 ? [] : await service.checkAll(principal, pending.map(({ check }) => ({ permission: check.permission, resource: check.resource })));
  if (decisions.length !== pending.length) throw new Error(`checkAll answered ${decisions.length} decisions for ${pending.length} requests`);
  pending.forEach(({ i, check }, k) => {
    [results[i], reasons[i]] = verdict(decisions[k], check, opts.authz);
  });

  return { results, reasons };
}
```

In `packages/authz-http/src/client-access/index.ts` append:

```ts
export * from './checks.js';
```

- [ ] **Step 5: Replace the controller**

Replace `packages/authz-http/src/controllers/AccessController.ts` with:

```ts
import { BaseController, BasePath, Body, Get, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';

import { domainService } from '../domains.js';
import { HasPrincipal } from '../access/principal-policies.js';
import { MAX_ACCESS_CHECKS, answerClientChecks } from '../client-access/checks.js';
import '../storage.js';

/** The caller's own access (design §10, §11.4), in the domain `authz.http.access.domain` (default root). */
@BasePath('user/access')
export class AccessController extends BaseController {
  @Config('authz.http.access.domain')
  protected AccessDomain: string;

  @Config('authz')
  protected Authz: unknown;

  @Logger('authz-http')
  protected Log: Log;

  @Get('/')
  @Policy(HasPrincipal)
  public async summary(@Req() req: Request) {
    const authz = await domainService(this.AccessDomain);
    return new Ok(await authz.summary(req.storage.Principal!));
  }

  /** ckit's `createHttpChecker` wire format: `{ checks }` → `{ results, reasons }` (design §10.2). */
  @Post('checks')
  @Policy(HasPrincipal)
  public async checks(@Req() req: Request, @Body() checks: unknown[]) {
    if (!Array.isArray(checks) || checks.length > MAX_ACCESS_CHECKS) {
      throw new InvalidArgument(`checks must be a list of at most ${MAX_ACCESS_CHECKS} entries`, 'checks');
    }
    const authz = await domainService(this.AccessDomain);
    return new Ok(await answerClientChecks(authz, req.storage.Principal!, checks, { authz: this.Authz, log: this.Log }));
  }
}
```

(`MAX_ACCESS_CHECKS` stays importable from `@spinajs/authz-http`: `index.ts` re-exports `client-access`. It must not also be exported from `AccessController.ts`, or the two `export *` lines of `index.ts` collide.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/authz && npm run compile && cd ../authz-http && npx ts-mocha -p tsconfig.json test/access-controller.test.ts`
Expected: PASS, `16 passing`, `0 failing`.

- [ ] **Step 7: Run the package suite for regressions**

Run: `cd packages/authz-http && npm test`
Expected: `0 failing`. (`test/support/http-harness.ts:207` mounts `AccessController` under a prefix; nothing there calls the removed route.)

- [ ] **Step 8: Commit**

```bash
git add packages/authz-http/src/client-access packages/authz-http/src/controllers/AccessController.ts packages/authz-http/test/access-controller.test.ts packages/authz-http/test/fixtures/ckit-http-checker.ts
git commit -m "feat(authz-http): POST /user/access/checks in ckit's wire format, replacing /user/access/check"
```

---

### Task 3: SSE transport and `GET /user/access/events`

**Files:**
- Create: `packages/authz-http/src/client-access/sse.ts`
- Modify: `packages/authz-http/src/client-access/index.ts`
- Modify: `packages/authz-http/src/controllers/AccessController.ts` (imports, one route)
- Test: `packages/authz-http/test/access-events.test.ts`

**Interfaces:**
- Consumes: L0 `AccessPushTransport { abstract readonly name: string; abstract push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> }`, `AccessChangedEvent { objects?: readonly ResourceRef[] }`; `Response` from `@spinajs/http`; `http.server.closing` (emitted by `HttpServer._close`, `packages/http/src/server.ts:354`).
- Consumes also: `AUTHZ_CHANGED_EVENT = 'authz.changed'` from `@spinajs/authz` (L2 Task 8).
- Produces: `SSE_HEARTBEAT_MS = 25_000`, `SSE_RETRY_MS = 5_000`, `sseFrame(event): string`, `pushKeys(principal): string[]`, `@Singleton() @Injectable(AccessPushTransport) class SseAccessPushTransport { name = 'sse'; heartbeatMs; open(req, res, principal): void; push(principals, event): Promise<void>; count(principalKey?): number; closeAll(): void }`, `class AccessEventStream extends Response`; route `GET /user/access/events` (`HasPrincipal`). L2's `AccessChangeRouter` finds the transport through `Array.chainOf(AccessPushTransport)` in the root container; the controller resolves the same singleton by class (the DI cache is keyed by the target class name).

- [ ] **Step 1: Write the failing test**

Create `packages/authz-http/test/access-events.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DI } from '@spinajs/di';
import { AccessPushTransport } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';

import { AccessController, SSE_RETRY_MS, SseAccessPushTransport } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

interface OpenStream {
  readonly res: http.IncomingMessage;
  /** The next frame without its blank-line terminator. */
  frame(ms?: number): Promise<string>;
  close(): void;
}

function openStream(app: TestApp, headers: Record<string, string>): Promise<OpenStream> {
  const { port } = app.server.Server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/user/access/events', headers }, (res) => {
      res.setEncoding('utf8');
      let buffer = '';
      const frames: string[] = [];
      const waiting: ((frame: string) => void)[] = [];
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const next = waiting.shift();
          if (next) next(frame);
          else frames.push(frame);
        }
      });
      const frame = (ms = 2000) =>
        frames.length > 0
          ? Promise.resolve(frames.shift()!)
          : new Promise<string>((ok, fail) => {
              const timer = setTimeout(() => fail(new Error(`no frame within ${ms} ms`)), ms);
              waiting.push((f) => {
                clearTimeout(timer);
                ok(f);
              });
            });
      resolve({ res, frame, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('GET /user/access/events (SSE, design §10.4)', function () {
  this.timeout(30000);

  let app: TestApp;
  let transport: SseAccessPushTransport;
  let unregisterSource: () => void;

  before(async () => {
    unregisterSource = registerHeaderSource();
    app = await startApp({ controllers: [AccessController] });
    transport = (await DI.resolve(SseAccessPushTransport)) as SseAccessPushTransport;
  });

  after(async () => {
    await stopApp();
    unregisterSource();
  });

  it('is the AccessPushTransport named sse the router finds', async () => {
    const transports = (await DI.resolve(Array.ofType(AccessPushTransport))) as AccessPushTransport[];
    expect(transports).to.include(transport);
    expect(transport.name).to.eq('sse');
  });

  it('answers an uncompressed, unbuffered text/event-stream that starts with a retry line', async () => {
    const s = await openStream(app, { 'x-user': 'alice', 'accept-encoding': 'gzip, deflate, br' });
    try {
      expect(s.res.statusCode).to.eq(200);
      expect(s.res.headers['content-type']).to.match(/^text\/event-stream/);
      expect(s.res.headers['cache-control']).to.include('no-transform');
      expect(s.res.headers['x-accel-buffering']).to.eq('no');
      expect(s.res.headers['content-encoding']).to.eq(undefined);
      expect(s.res.headers['x-access-epoch']).to.match(/^[0-9a-f]{16}$/);
      expect(await s.frame()).to.eq(`retry: ${SSE_RETRY_MS}`);
    } finally {
      s.close();
    }
  });

  it("pushes authz.changed to the named principals' streams, and '*' to every stream", async () => {
    const alice = await openStream(app, { 'x-user': 'alice' });
    const bob = await openStream(app, { 'x-user': 'bob' });
    try {
      await alice.frame();
      await bob.frame();

      await transport.push(['user:alice'], { objects: [{ type: 'doc', id: '1' }] });
      await transport.push(['user:carol'], { objects: [{ type: 'doc', id: '2' }] });
      await transport.push('*', {});

      expect(await alice.frame()).to.eq('event: authz.changed\ndata: {"objects":[{"type":"doc","id":"1"}]}');
      expect(await alice.frame()).to.eq('event: authz.changed\ndata: {}');
      // bob's first event is the broadcast: neither alice's nor carol's push reached him
      expect(await bob.frame()).to.eq('event: authz.changed\ndata: {}');
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('sends a heartbeat comment', async () => {
    transport.heartbeatMs = 50;
    const s = await openStream(app, { 'x-user': 'alice' });
    try {
      await s.frame();
      expect(await s.frame()).to.eq(': heartbeat');
    } finally {
      s.close();
      transport.heartbeatMs = 25_000;
    }
  });

  it('forgets a stream once the client goes away', async () => {
    const s = await openStream(app, { 'x-user': 'dave' });
    await s.frame();
    expect(transport.count('user:dave')).to.eq(1);

    s.close();
    await until(() => transport.count('user:dave') === 0);
  });

  it('answers 401 without a principal', async () => {
    testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], false);
    try {
      const s = await openStream(app, {});
      expect(s.res.statusCode).to.eq(401);
      s.close();
    } finally {
      testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], true);
    }
  });

  // Last: it stops the app.
  it('ends the open streams when the http server stops', async () => {
    const s = await openStream(app, { 'x-user': 'alice' });
    await s.frame();
    const ended = new Promise<void>((resolve) => s.res.once('end', () => resolve()));

    const started = Date.now();
    await stopApp();
    await ended;
    expect(Date.now() - started).to.be.below(5000);
    expect(transport.count()).to.eq(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-http && npx ts-mocha -p tsconfig.json test/access-events.test.ts`
Expected: FAIL with a TSError `Module '"../src/index.js"' has no exported member 'SseAccessPushTransport'`.

- [ ] **Step 3: Write the transport**

Create `packages/authz-http/src/client-access/sse.ts`:

```ts
import { DI, Injectable, Singleton } from '@spinajs/di';
import { AUTHZ_CHANGED_EVENT, AccessPushTransport, principalKey } from '@spinajs/authz';
import type { AccessChangedEvent, Principal } from '@spinajs/authz';
import { Response as HttpResponse } from '@spinajs/http';
import type * as express from 'express';

/** Below the 30 s idle timeout of common proxies. */
export const SSE_HEARTBEAT_MS = 25_000;

export const SSE_RETRY_MS = 5_000;

export function sseFrame(event: AccessChangedEvent): string {
  return `event: ${AUTHZ_CHANGED_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The principal keys a stream hears: the principal's and those of the identities that speak with it. */
export function pushKeys(principal: Principal): string[] {
  return [...new Set([principal, ...(principal.companions ?? [])].map((p) => principalKey(p)))];
}

/** Server-sent `authz.changed` events for clients without the socket (design §10.4); `@spinajs/http` has no SSE. */
@Singleton()
@Injectable(AccessPushTransport)
export class SseAccessPushTransport extends AccessPushTransport {
  public readonly name = 'sse';

  /** Tests shorten it; read when a stream opens. */
  public heartbeatMs = SSE_HEARTBEAT_MS;

  protected readonly streams = new Map<string, Set<express.Response>>();

  protected listening = false;

  public open(req: express.Request, res: express.Response, principal: Principal): void {
    this.listenForShutdown();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // no-transform: the compression middleware skips the response instead of buffering its frames
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    req.socket.setNoDelay(true);
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    const keys = pushKeys(principal);
    for (const key of keys) {
      let set = this.streams.get(key);
      if (!set) this.streams.set(key, (set = new Set()));
      set.add(res);
    }

    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), this.heartbeatMs);
    heartbeat.unref();

    // res, not req: res 'close' also fires when we end the stream ourselves
    res.once('close', () => {
      clearInterval(heartbeat);
      for (const key of keys) {
        const set = this.streams.get(key);
        set?.delete(res);
        if (set?.size === 0) this.streams.delete(key);
      }
    });
  }

  public async push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> {
    const frame = sseFrame(event);
    for (const res of this.targets(principals)) {
      if (!res.writableEnded) res.write(frame);
    }
  }

  /** Open streams of one principal key, or all of them. */
  public count(principal?: string): number {
    return principal === undefined ? this.targets('*').size : (this.streams.get(principal)?.size ?? 0);
  }

  public closeAll(): void {
    for (const res of this.targets('*')) res.end();
  }

  protected targets(principals: readonly string[] | '*'): Set<express.Response> {
    const sets = principals === '*' ? [...this.streams.values()] : principals.map((k) => this.streams.get(k) ?? new Set<express.Response>());
    return new Set(sets.flatMap((s) => [...s]));
  }

  // An open stream would hold server.close() until the shutdown watchdog fires.
  protected listenForShutdown(): void {
    if (this.listening) return;
    this.listening = true;
    DI.on('http.server.closing', () => this.closeAll());
  }
}

/** What `GET /user/access/events` returns: it hands the express response to the transport and sends no body itself. */
export class AccessEventStream extends HttpResponse {
  constructor(
    protected readonly transport: SseAccessPushTransport,
    protected readonly principal: Principal,
  ) {
    super(null);
  }

  public async execute(req: express.Request, res: express.Response): Promise<void> {
    this.transport.open(req, res, this.principal);
  }
}
```

In `packages/authz-http/src/client-access/index.ts` append:

```ts
export * from './sse.js';
```

- [ ] **Step 4: Add the route**

In `packages/authz-http/src/controllers/AccessController.ts`:

add to the imports:

```ts
import { DI } from '@spinajs/di';
import { AccessEventStream, SseAccessPushTransport } from '../client-access/sse.js';
```

and add after the `checks` method:

```ts
  /** `authz.changed` server-sent events for the caller (design §10.4). */
  @Get('events')
  @Policy(HasPrincipal)
  public async events(@Req() req: Request) {
    const transport = (await DI.resolve(SseAccessPushTransport)) as SseAccessPushTransport;
    return new AccessEventStream(transport, req.storage.Principal!);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/authz-http && npx ts-mocha -p tsconfig.json test/access-events.test.ts`
Expected: PASS, `7 passing`, `0 failing`. If the compression case fails with `content-encoding: gzip`, a middleware sets headers after `Cache-Control`: check that nothing in the stack overwrites `Cache-Control` before `flushHeaders()` (helmet does not).

- [ ] **Step 6: Run the package suite for regressions**

Run: `cd packages/authz-http && npm test`
Expected: `0 failing`.

- [ ] **Step 7: Commit**

```bash
git add packages/authz-http/src/client-access packages/authz-http/src/controllers/AccessController.ts packages/authz-http/test/access-events.test.ts
git commit -m "feat(authz-http): SSE AccessPushTransport and GET /user/access/events"
```

---

### Task 4: explain `format=tree`

**Files:**
- Create: `packages/authz-http/src/explain/tree.ts`
- Modify: `packages/authz-http/src/explain/index.ts`, `packages/authz-http/src/explain/controller.ts:57-68`
- Test: `packages/authz-http/test/explain-tree.test.ts` (new), `packages/authz-http/test/explain.test.ts` (one case)

**Interfaces:**
- Consumes: `Decision`, `Trace`, `TraceStep`, `Vote` (`packages/authz/src/contracts/decision.ts:31-76`), `resourceKey`.
- Produces: `interface ExplainNode { label: string; allowed: boolean; children: readonly ExplainNode[] }`, `explainTree(decision: Decision): ExplainNode`; `GET /authz/explain?...&format=tree|decision` (default `decision`; anything else 400).

- [ ] **Step 1: Write the failing unit test**

Create `packages/authz-http/test/explain-tree.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { FALSE, TRUE } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';

import { explainTree } from '../src/index.js';

const base = { permission: 'doc:edit', resource: { type: 'doc', id: '1' }, principal: { type: 'user', id: 'alice' }, fields: { read: ['*'], write: ['*'] }, roles: {}, domain: 'root' };

describe('explainTree (design §10.6)', () => {
  it('maps the decision, each vote with its steps, then the engine steps', () => {
    const decision: Decision = {
      ...base,
      allowed: true,
      residual: TRUE,
      trace: {
        domain: 'root',
        algorithm: 'deny-overrides',
        models: ['rbac', 'abac'],
        durationMs: 3,
        votes: [
          { model: 'rbac', permitWhen: TRUE, denyWhen: FALSE, cacheable: true, trace: [{ by: 'rbac', step: 'role', note: 'editor at doc:1', data: { x: 1 } }] },
          { model: 'abac', permitWhen: FALSE, denyWhen: FALSE, cacheable: true },
        ],
        steps: [{ by: 'core', step: 'combine', note: 'deny-overrides: permit' }],
      },
    };

    expect(explainTree(decision)).to.deep.equal({
      label: 'doc:1#doc:edit = allow',
      allowed: true,
      children: [
        { label: 'rbac: permit', allowed: true, children: [{ label: 'rbac role: editor at doc:1', allowed: true, children: [] }] },
        { label: 'abac: abstain', allowed: false, children: [] },
        { label: 'deny-overrides over [rbac, abac] in root', allowed: true, children: [{ label: 'core combine: deny-overrides: permit', allowed: true, children: [] }] },
      ],
    });
  });

  it('labels deny, error, conditional and abstain-with-reason votes', () => {
    const cond = { op: 'cmp', field: 'status', cmp: 'eq', value: 'open' } as const;
    const decision: Decision = {
      ...base,
      allowed: false,
      residual: FALSE,
      reason: { code: 'role_denied', model: 'rbac' },
      trace: {
        domain: 'root',
        algorithm: 'deny-overrides',
        models: ['rbac', 'abac', 'x', 'y'],
        durationMs: 1,
        votes: [
          { model: 'rbac', permitWhen: FALSE, denyWhen: TRUE, reason: { code: 'role_denied' }, cacheable: true },
          { model: 'abac', permitWhen: cond, denyWhen: FALSE, cacheable: true },
          { model: 'x', permitWhen: FALSE, denyWhen: FALSE, error: 'timeout', cacheable: false },
          { model: 'y', permitWhen: FALSE, denyWhen: FALSE, reason: { code: 'no_access' }, cacheable: true },
        ],
        steps: [],
      },
    };

    const tree = explainTree(decision);
    expect(tree.label).to.eq('doc:1#doc:edit = deny (role_denied)');
    expect(tree.allowed).to.eq(false);
    expect(tree.children.map((c) => [c.label, c.allowed])).to.deep.equal([
      ['rbac: deny (role_denied)', false],
      ['abac: conditional', false],
      ['x: error (timeout)', false],
      ['y: abstain (no_access)', false],
      ['deny-overrides over [rbac, abac, x, y] in root', false],
    ]);
  });

  it('marks a conditional decision not allowed, and has no children without a trace', () => {
    const tree = explainTree({ ...base, allowed: true, residual: { op: 'cmp', field: 'status', cmp: 'eq', value: 'open' } });
    expect(tree).to.deep.equal({ label: 'doc:1#doc:edit = conditional', allowed: false, children: [] });
  });
});
```

- [ ] **Step 2: Add the route case**

In `packages/authz-http/test/explain.test.ts`, after the case `'outside production the enabled route answers the decision with its trace'`, add:

```ts
  it('format=tree answers { label, allowed, children } built from the trace, and another format is a 400', async () => {
    running = await boot({ 'authz.http.explainRoute': { enabled: true, permission: 'authz:explain' }, 'configuration.isProduction': false });

    const res = await running.app.request().get(`${EXPLAIN}&format=tree`).set('x-user', 'bob');

    expect(res.status).to.eq(200);
    expect(res.body.label).to.match(/^file:f1#file:read = deny \(.+\)$/);
    expect(res.body.allowed).to.eq(false);
    expect(res.body.children.map((c: { label: string }) => c.label)).to.include.members(['m1: abstain']);
    expect(res.body.children.at(-1).label).to.match(/^deny-overrides over \[m1\] in exp$/);
    expect((await running.app.request().get(`${EXPLAIN}&format=xml`).set('x-user', 'bob')).status).to.eq(400);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/authz-http && npx ts-mocha -p tsconfig.json test/explain-tree.test.ts test/explain.test.ts`
Expected: FAIL with a TSError `Module '"../src/index.js"' has no exported member 'explainTree'`.

- [ ] **Step 4: Write the mapping**

Create `packages/authz-http/src/explain/tree.ts`:

```ts
import { resourceKey } from '@spinajs/authz';
import type { Decision, TraceStep, Vote } from '@spinajs/authz';

/** A generic explanation tree; the shape of ckit's `ExplainNode` (design §10.6). */
export interface ExplainNode {
  readonly label: string;
  readonly allowed: boolean;
  readonly children: readonly ExplainNode[];
}

const definite = (d: Decision): boolean => d.allowed && d.residual.op === 'true';

function verdict(d: Decision): string {
  if (definite(d)) return 'allow';
  if (d.allowed) return 'conditional';
  return `deny (${d.reason?.code ?? 'no_access'})`;
}

const why = (v: Vote): string => (v.reason ? ` (${v.reason.code})` : '');

function voteVerdict(v: Vote): string {
  if (v.error !== undefined) return `error (${v.error})`;
  if (v.denyWhen.op === 'true') return `deny${why(v)}`;
  if (v.permitWhen.op === 'true' && v.denyWhen.op === 'false') return 'permit';
  if (v.permitWhen.op === 'false' && v.denyWhen.op === 'false') return `abstain${why(v)}`;
  return 'conditional';
}

// Steps carry no verdict of their own; they take their parent's.
const stepNodes = (steps: readonly TraceStep[], allowed: boolean): ExplainNode[] => steps.map((s) => ({ label: `${s.by} ${s.step}: ${s.note}`, allowed, children: [] }));

export function explainTree(d: Decision): ExplainNode {
  const allowed = definite(d);
  const children: ExplainNode[] = [];
  if (d.trace) {
    for (const v of d.trace.votes) {
      const label = voteVerdict(v);
      children.push({ label: `${v.model}: ${label}`, allowed: label === 'permit', children: stepNodes(v.trace ?? [], label === 'permit') });
    }
    children.push({ label: `${d.trace.algorithm} over [${d.trace.models.join(', ')}] in ${d.trace.domain}`, allowed, children: stepNodes(d.trace.steps, allowed) });
  }
  return { label: `${resourceKey(d.resource)}#${d.permission} = ${verdict(d)}`, allowed, children };
}
```

In `packages/authz-http/src/explain/index.ts` append:

```ts
export * from './tree.js';
```

In `packages/authz-http/src/explain/controller.ts` add the import `import { explainTree } from './tree.js';` and replace the `explain` method (lines 57-68) with:

```ts
  @Get('explain')
  @Policy(ExplainPolicy)
  public async explain(@Req() _req: Request, @Query() principal: string, @Query() permission: string, @Query() resource?: string, @Query() format?: string) {
    if (format !== undefined && format !== '' && format !== 'decision' && format !== 'tree') throw new InvalidArgument("format must be 'decision' or 'tree'", 'format');
    const target = splitKey(principal, 'principal');
    if (target.id === undefined) throw new InvalidArgument('principal must be <type>:<id>', 'principal');
    if (!isPermission(permission)) throw new InvalidArgument('permission must be a permission name', 'permission');
    const ref: ResourceRef = resource === undefined || resource === '' ? { type: parsePermission(permission).resource } : splitKey(resource, 'resource');

    const subject: Principal = Object.freeze({ type: target.type, id: target.id, authenticated: target.type !== 'anonymous' && target.type !== 'unattended', source: 'explain', attributes: Object.freeze({}) });
    const authz = await domainService(this.AccessDomain);
    const decision = await authz.explain({ principal: subject, permission, resource: ref });
    return new Ok(format === 'tree' ? explainTree(decision) : decision);
  }
```

Also extend the class doc comment's route line to `GET /authz/explain?principal=<type>:<id>&permission=&resource=<type>[:<id>]&format=decision|tree`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/authz-http && npx ts-mocha -p tsconfig.json test/explain-tree.test.ts test/explain.test.ts`
Expected: PASS, `9 passing` (3 + 6), `0 failing`. If `m1: abstain` is reported as `m1: abstain (<code>)`, the StaticModel sets a reason on an empty vote: change the assertion to a `/^m1: abstain/` match, not the mapping.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-http/src/explain packages/authz-http/test/explain-tree.test.ts packages/authz-http/test/explain.test.ts
git commit -m "feat(authz-http): explain format=tree, Decision.trace as { label, allowed, children }"
```

---

### Task 5: Docs and lane verification

**Files:**
- Modify: `packages/authz-http/README.md`, `packages/authz-http/src/config/authz-http.ts:26`, `packages/authz-http/src/http-config.ts:33`, `docs/authz/README.md:509-511`, `docs/authz/migration-guide.md:359`

- [ ] **Step 1: Fix the doc comments naming the old route**

In `packages/authz-http/src/config/authz-http.ts:26` and `packages/authz-http/src/http-config.ts:33` replace `/** The domain GET /user/access and POST /user/access/check answer for. */` with:

```ts
      /** The domain GET /user/access, POST /user/access/checks and the explain route answer for. */
```

(keep each file's indentation).

- [ ] **Step 2: Add the client section to the package README**

Append to `packages/authz-http/README.md`:

````markdown
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
````

- [ ] **Step 3: Update the shared docs**

In `docs/authz/README.md`, replace lines 509-511:

```markdown
- `GET /user/access` returns the access summary. `POST /user/access/check` checks up to 100
  permissions. `GET /authz/explain` exists only when `authz.http.explainRoute.enabled` is true and
  never in production (H19, B41).
```

with:

```markdown
- `GET /user/access` returns the access summary. `POST /user/access/checks` answers up to 100 client
  checks, `GET /user/access/events` streams `authz.changed`, and every response carries
  `X-Access-Epoch` (see `packages/authz-http/README.md`). `GET /authz/explain` exists only when
  `authz.http.explainRoute.enabled` is true and never in production (H19, B41).
```

In `docs/authz/migration-guide.md:359` replace `` `POST /user/access/check` `` with `` `POST /user/access/checks` ``.

- [ ] **Step 4: Whole package**

Run: `cd packages/authz-http && npm test`
Expected: `0 failing`.

- [ ] **Step 5: No stale references**

Run (repo root): `grep -rn "access/check\b\|access/check'" packages/*/src packages/*/test docs/authz`
Expected: no output.

- [ ] **Step 6: API snapshot unchanged**

Run (repo root): `npm run build && node scripts/api-snapshot.mjs --check`
Expected: the check passes (`src/api.ts` untouched).

- [ ] **Step 7: Commit**

```bash
git add packages/authz-http/README.md packages/authz-http/src/config/authz-http.ts packages/authz-http/src/http-config.ts docs/authz/README.md docs/authz/migration-guide.md
git commit -m "docs(authz-http): client access API, epoch, SSE and explain tree"
```

---

## Contract issues found

1. **ckit's request body has no literal fixture.** `ckit/packages/access/src/http.test.ts` builds its bodies with `request()` and the default `encodeChecks`; it never spells one out. The fixture in Task 2 is that test's first exchange serialized exactly as `createHttpChecker` sends it (verified by replaying `encodeChecks` over the test's requests). Non-blocking; a ckit-side literal fixture would make the conformance stronger (for L9's `runClientAccessConformance`).
