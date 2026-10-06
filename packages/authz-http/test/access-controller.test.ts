import 'mocha';
import { expect } from 'chai';
import { FakeRbacModel, testHost, userPrincipal } from '@spinajs/authz-testing';

import { AccessController, MAX_ACCESS_CHECKS } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { createDomain } from './support/domain.js';
import type { TestDomain } from './support/domain.js';
import { registerHeaderSource } from './support/principals.js';

const D = 'acs';

describe('AccessController (B25)', function () {
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
    domain = await createDomain(D, { permissions: { 'file:read': {}, 'file:write': {}, 'file:delete': {} }, extraModel: rbac });
  });

  after(async () => {
    testHost.config().unset(['authz', 'http', 'access']);
    await domain?.dispose();
    await stopApp();
    unregisterSource();
  });

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
      testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], false);
      try {
        expect((await app.request().get('/user/access')).status).to.eq(401);
      } finally {
        testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], true);
      }
    });
  });

  describe('POST /user/access/check', () => {
    it('answers each check with its decision, without a trace', async () => {
      const res = await app
        .request()
        .post('/user/access/check')
        .set('x-user', 'alice')
        .send({ checks: [{ permission: 'file:read', resource: { type: 'file', id: 'f1' } }, { permission: 'file:delete' }] });

      expect(res.status).to.eq(200);
      expect(res.body.decisions).to.have.length(2);
      expect(res.body.decisions[0]).to.deep.include({ allowed: true, permission: 'file:read', resource: { type: 'file', id: 'f1' } });
      expect(res.body.decisions[1]).to.deep.include({ allowed: false, permission: 'file:delete', resource: { type: 'file' } });
      for (const d of res.body.decisions) expect(d).to.not.have.property('trace');
    });

    it('needs an authenticated principal', async () => {
      expect((await app.request().post('/user/access/check').send({ checks: [{ permission: 'file:read' }] })).status).to.eq(401);
    });

    it(`refuses an empty list, more than ${MAX_ACCESS_CHECKS} checks, a malformed entry or an unknown permission with 400`, async () => {
      const post = (checks: unknown) => app.request().post('/user/access/check').set('x-user', 'alice').send({ checks });

      expect((await post([])).status).to.eq(400);
      expect((await post(Array.from({ length: MAX_ACCESS_CHECKS + 1 }, () => ({ permission: 'file:read' })))).status).to.eq(400);
      expect((await post([{ permission: 'not a permission' }])).status).to.eq(400);
      expect((await post([{ permission: 'file:read', resource: { type: 'file', id: 1 } }])).status).to.eq(400);
      expect((await post([{ permission: 'file:read', resource: { type: 'file', extra: 'x' } }])).status).to.eq(400);
      expect((await post([{ permission: 'ghost:read' }])).status).to.eq(400);
    });
  });
});
