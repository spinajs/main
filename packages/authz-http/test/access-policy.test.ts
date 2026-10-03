import 'mocha';
import { expect } from 'chai';
import type { DecisionRequest } from '@spinajs/authz';
import { BaseController, BasePath, Get, Ok, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { FakeAdapter, testHost } from '@spinajs/authz-testing';
import type { ScriptedVote } from '@spinajs/authz-testing';

import { Access, typedExtractor } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { createDomain } from './support/domain.js';
import type { TestDomain } from './support/domain.js';
import { registerHeaderSource } from './support/principals.js';

const fromParamForTests = (param: string, type: string) => typedExtractor(type, (req) => ({ type, id: req.params[param] }));

const D = 'pol';
const OTHER = 'pol-other';
const LOCKED = { code: 'locked', priority: 50, sortKey: 'k', detail: 'd' };

const permissions = { 'file:read': {}, 'file:write': {}, 'authz:explain': {} };
const rows = { file: [{ id: 'f1', owner: 'alice' }, { id: 'f2', owner: 'bob' }] };

// alice: file:read on her own rows only (a residual); carol: denied with LOCKED; bob: authz:explain.
const votes = (req: DecisionRequest): ScriptedVote => {
  if (req.permission === 'authz:explain') return req.principal.id === 'bob' ? { permitWhen: { op: 'true' } } : {};
  if (req.principal.id === 'carol') return { denyWhen: { op: 'true' }, denies: [{ when: { op: 'true' }, reason: LOCKED }] };
  if (req.principal.id === 'alice' && req.permission === 'file:read') return { permitWhen: { op: 'cmp', field: 'owner', cmp: 'eq', value: 'alice' } };
  return {};
};

const ok = (req: Request) => new Ok({ allowed: req.storage.AuthzDecision?.allowed ?? null, residual: req.storage.AuthzDecision?.residual.op ?? null });

@BasePath('pol')
class PolicyRoutes extends BaseController {
  @Get('files/:id')
  @Access('file:read', { domain: D, resource: fromParamForTests('id', 'file') })
  public read(@Req() req: Request) {
    return ok(req);
  }

  @Get('loaded/:id')
  @Access('file:read', { domain: D, resource: fromParamForTests('id', 'file'), subject: 'load' })
  public loaded(@Req() req: Request) {
    return ok(req);
  }

  @Get('other/:id')
  @Access('file:read', { domain: OTHER, resource: fromParamForTests('id', 'file') })
  public other(@Req() req: Request) {
    return ok(req);
  }
}

describe('AccessPolicy', function () {
  this.timeout(30000);

  let app: TestApp;
  let domain: TestDomain;
  let other: TestDomain;
  let unregisterSource: () => void;

  before(async () => {
    unregisterSource = registerHeaderSource();
    app = await startApp({ controllers: [PolicyRoutes] });
    domain = await createDomain(D, { permissions, model: { votes }, adapters: [new FakeAdapter({ types: ['file'], rows })] });
    other = await createDomain(OTHER, { permissions, model: { votes: () => ({}) } });
  });

  after(async () => {
    await other?.dispose();
    await domain?.dispose();
    await stopApp();
    unregisterSource();
  });

  const explain = (on: boolean, production: boolean) => {
    testHost.config().set(['authz', 'domains', D, 'engine'], { explain: on });
    testHost.config().set(['configuration', 'isProduction'], production);
  };

  afterEach(() => {
    testHost.config().unset(['authz', 'domains', D, 'engine']);
    testHost.config().unset(['configuration', 'isProduction']);
  });

  it('answers a denial 403 { error, permission, resource, reason } with the reason payload, without priority and sortKey', async () => {
    const res = await app.request().get('/pol/files/f1').set('x-user', 'carol');

    expect(res.status).to.eq(403);
    expect(res.body).to.deep.include({ error: 'forbidden', permission: 'file:read', resource: { type: 'file', id: 'f1' }, reason: { code: 'locked', model: 'm1', detail: 'd' } });
    expect(res.body).to.not.have.property('decision');
  });

  it('answers a request without an authenticated principal 401 { error: unauthenticated }', async () => {
    const res = await app.request().get('/pol/files/f1');

    expect(res.status).to.eq(401);
    expect(res.body).to.deep.include({ error: 'unauthenticated' });
  });

  it('lets a conditional allow through and keeps it, with its residual, for the ORM', async () => {
    const res = await app.request().get('/pol/files/f2').set('x-user', 'alice');

    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ allowed: true, residual: 'cmp' });
  });

  it("subject: 'load' settles a conditional allow against the row the adapter loads", async () => {
    const own = await app.request().get('/pol/loaded/f1').set('x-user', 'alice');
    expect(own.status).to.eq(200);
    expect(own.body.allowed).to.eq(true);

    expect((await app.request().get('/pol/loaded/f2').set('x-user', 'alice')).status).to.eq(403);
    expect((await app.request().get('/pol/loaded/missing').set('x-user', 'alice')).status).to.eq(403);
  });

  it('checks in the domain the @Access names', async () => {
    domain.model.calls.length = 0;
    const res = await app.request().get('/pol/other/f1').set('x-user', 'alice');

    expect(res.status).to.eq(403);
    expect(domain.model.requests.some((r) => r.resource.id === 'f1' && r.principal.id === 'alice')).to.eq(false);
  });

  describe('trace in a 403 (B23, B41)', () => {
    beforeEach(() => {
      domain.model.calls.length = 0;
    });

    it('outside production, with engine.explain on and a caller holding authz:explain, carries the trace', async () => {
      explain(true, false);
      const res = await app.request().get('/pol/files/f1').set('x-user', 'bob');

      expect(res.status).to.eq(403);
      expect(res.body.trace).to.be.an('object');
    });

    it('in production never', async () => {
      explain(true, true);
      const res = await app.request().get('/pol/files/f1').set('x-user', 'bob');

      expect(res.status).to.eq(403);
      expect(res.body).to.not.have.property('trace');
    });

    it('not while engine.explain is off', async () => {
      explain(false, false);
      expect((await app.request().get('/pol/files/f1').set('x-user', 'bob')).body).to.not.have.property('trace');
    });

    it('not for a caller without authz:explain', async () => {
      explain(true, false);
      expect((await app.request().get('/pol/files/f1').set('x-user', 'carol')).body).to.not.have.property('trace');
    });
  });
});
