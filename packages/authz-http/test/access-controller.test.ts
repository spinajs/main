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
