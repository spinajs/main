import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { AuthzAdminFailure, AuthzAdminReader, AuthzConfigError, AuthzDomains, AuthzService, AuthzWriteHandler, GLOBAL } from '@spinajs/authz';
import type { AuthzAdminQuery, AuthzCommand, Principal } from '@spinajs/authz';
import { anonymousPrincipal, fixtureDsl, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { BehaviourHarness, BehaviourId, HarnessSession, World } from '@spinajs/authz-testing';
import { IsAuthenticated } from '@spinajs/authz-http';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';
import { FrameworkLogger } from '@spinajs/log';

import { AuthzAdminController } from '../src/controllers/AuthzAdminController.js';
import { adminDomain, domainAdmin } from '../src/routes/index.js';
import { DOMAIN, adminHttpHarness, send } from './support/admin-http.js';
import type { RawRequest, RawResponse } from './support/admin-http.js';

const { assignment, combine, ref, role } = fixtureDsl;

const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const F1 = ref('file', 'f1');
const UPLOAD = ref('file', 'uploads:a/b.pdf');
const G1 = ref('group', 'g1');

const TYPES = ['org', 'project', 'file', 'group'];
const MANAGE = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage', 'authz:policies.manage', 'authz:scope.manage'];
const READ = ['authz:assignments.read', 'authz:links.read', 'authz:rules.read', 'authz:policies.read', 'authz:attributes.read'];

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const root = userPrincipal('root');

const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = '2027-01-01T00:00:00.000Z';

const ORG_SCHEMA = {
  scopeType: 'org',
  schema: { type: 'object', properties: { policies: { type: 'object', properties: { public_links: { type: 'boolean' } }, additionalProperties: false } }, additionalProperties: false },
  defaults: { policies: { public_links: true } },
};

// root manages and reads everything at GLOBAL and holds editor there, so the guard lets it grant,
// link and require up to editor; bob may manage assignments at p1 only, up to his editor there.
const world: World = {
  now: NOW,
  permissions: ['file:read', 'file:edit', ...MANAGE, ...READ].map((name) => ({ name, types: TYPES })),
  principals: { alice, bob, carol, root },
  scopes: [
    {
      nodes: [
        { ref: P1, parent: O1 },
        { ref: F1, parent: P1 },
        { ref: UPLOAD, parent: P1 },
        { ref: P2, parent: O1 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    ladders: [{ name: 'project', roles: ['viewer', 'editor'] }],
    roles: [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:read', 'file:edit'], { ladder: 'project' }), role('manager', ['authz:assignments.manage', 'authz:assignments.read']), role('group.member', [], { subjectSet: true, scopeTypes: ['group'] }), role('superuser', ['file:read', 'file:edit', ...MANAGE, ...READ])],
    assignments: [assignment('r1', root, 'superuser'), assignment('r2', root, 'editor'), assignment('b1', bob, 'manager', P1), assignment('b2', bob, 'editor', P1), assignment('u1', alice, 'viewer', UPLOAD)],
  },
  scopeAttributes: { schemas: [ORG_SCHEMA] },
};

const grant = (who: string, roleName = 'viewer', scope = P1): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id: who }, role: roleName, scope });

const commands = (as: Principal | undefined, body: unknown): Promise<RawResponse> => send({ method: 'POST', path: '/authz/commands', body, ...(as ? { as } : {}) });
const call = (method: RawRequest['method'], path: string, as: Principal | undefined = root, body?: unknown): Promise<RawResponse> => send({ method, path, ...(as ? { as } : {}), ...(body === undefined ? {} : { body }) });

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'security'] as const;

const logText = (a: unknown): string => {
  if (a instanceof Error) return `${a.message} ${a.stack ?? ''}`;
  try {
    return typeof a === 'string' ? a : JSON.stringify(a);
  } catch {
    return String(a);
  }
};

/** Every log call made through FrameworkLogger until `restore()`, as text. */
function captureLogs(): { readonly lines: string[]; restore(): void } {
  const lines: string[] = [];
  const proto = FrameworkLogger.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = LOG_LEVELS.map((level) => [level, proto[level]] as const).filter(([, fn]) => typeof fn === 'function');
  for (const [level, fn] of originals) {
    proto[level] = function (this: unknown, ...args: unknown[]) {
      lines.push(args.map(logText).join(' '));
      return fn.apply(this, args);
    };
  }
  expect(originals, 'FrameworkLogger has log methods to capture').to.not.be.empty;
  return {
    lines,
    restore() {
      for (const [level, fn] of originals) proto[level] = fn;
    },
  };
}

const policyCommands: AuthzCommand[] = [];
const policyQueries: AuthzAdminQuery[] = [];

/** Stands in for authz-abac's policy handler, which this package must not load: records what AuthzAdmin hands it. */
class RecordingPolicyHandler extends AuthzWriteHandler {
  readonly kinds = ['policy.put', 'policy.delete'] as const;

  async validate(c: AuthzCommand): Promise<void> {
    if (c.kind !== 'policy.put') return;
    const at = c.policy.expiresAt;
    if (at !== undefined && at !== null && !(at instanceof Date)) throw new AuthzAdminFailure('invalid_command', 'policy.expiresAt must be a Date or null', 'policy.expiresAt');
  }

  permission() {
    return { permission: 'authz:policies.manage', resource: GLOBAL };
  }

  async apply(c: AuthzCommand) {
    policyCommands.push(c);
    return { id: c.kind === 'policy.put' ? c.policy.id : (c as { id: string }).id, affected: 1, tags: [], events: [] };
  }
}

class RecordingPolicyReader extends AuthzAdminReader {
  readonly kinds = ['policies'] as const;

  async list(q: AuthzAdminQuery) {
    policyQueries.push(q);
    return { items: [{ id: 'p1' }], total: 1 };
  }
}

describe('authz-http-admin routes', function () {
  this.timeout(30000);

  let harness: BehaviourHarness;
  let session: HarnessSession | undefined;
  let caseNo = 0;

  before(async () => {
    DI.register(RecordingPolicyHandler).as(AuthzWriteHandler);
    DI.register(RecordingPolicyReader).as(AuthzAdminReader);
    harness = adminHttpHarness();
    await harness.beforeAll?.();
  });

  after(async () => {
    try {
      await harness.afterAll?.();
    } finally {
      for (const t of [RecordingPolicyHandler, RecordingPolicyReader] as Class<unknown>[]) {
        DI.unregister(t);
        DI.uncache(t);
      }
    }
  });

  beforeEach(async function () {
    policyCommands.length = 0;
    policyQueries.length = 0;
    const title = this.currentTest?.fullTitle() ?? `case ${++caseNo}`;
    session = await harness.setup(world, { id: 'B43' as BehaviourId, part: 'routes', case: title, title, facets: ['http', 'engine', 'rbac', 'admin'] });
  });

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
  });

  const assignments = async (query = ''): Promise<any[]> => {
    const res = await call('GET', `/authz/assignments${query}`);
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    return res.body.items;
  };

  describe('authentication', () => {
    // Built from the controller's own route table, so a route added later is covered without a list to update.
    const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AuthzAdminController.prototype) as IControllerDescriptor;
    const routes = [...descriptor.Routes.values()].map((r) => [r.Type.toUpperCase() as RawRequest['method'], `/authz/${(r.Path ?? '').replace(':type', 'org').replace(':id', 'u1')}`] as const);

    it('applies IsAuthenticated to the whole controller', () => {
      expect(descriptor.Policies.flat().map((p) => p.Type)).to.deep.equal([IsAuthenticated]);
      expect(routes).to.have.length(18);
    });

    it('refuses a request without a principal with 401 on every route', async () => {
      for (const [method, path] of routes) {
        const res = await send({ method, path, body: {} });
        expect(res.status, `${method} ${path}`).to.equal(401);
      }
      expect(await assignments('?subject=user:alice')).to.have.length(1);
    });

    it('refuses an anonymous principal with 401 on every route', async () => {
      for (const [method, path] of routes) {
        const res = await send({ method, path, as: anonymousPrincipal(), body: { commands: [grant('carol')], ...grantBody('viewer') } });
        expect(res.status, `${method} ${path}`).to.equal(401);
      }
      expect(await assignments('?subject=user:carol')).to.deep.equal([]);
      expect((await call('GET', '/authz/links')).body.items).to.deep.equal([]);
    });
  });

  describe('POST /authz/commands', () => {
    it('runs the batch as the request principal and answers its results', async () => {
      const res = await commands(bob, { commands: [grant('carol')] });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.results).to.have.length(1);
      expect(res.body.results[0]).to.include({ ok: true, kind: 'assignment.grant', affected: 1 });
      const [row] = await assignments('?subject=user:carol');
      expect(row).to.deep.include({ id: res.body.results[0].id, role: 'viewer', scope: P1 });
    });

    it('takes no actor from the body: the principal is the actor', async () => {
      const res = await commands(carol, { commands: [grant('carol')], actor: { type: 'user', id: 'root' }, principal: root });
      expect(res.status).to.equal(403);
      expect(res.body.results[0].error.code).to.equal('forbidden');
      expect(await assignments('?subject=user:carol')).to.deep.equal([]);
    });

    it('answers 403 for a refused command, with the results in the body', async () => {
      const res = await commands(bob, { commands: [grant('carol'), grant('carol', 'viewer', P2)] });
      expect(res.status).to.equal(403);
      expect(res.body.results).to.have.length(2);
      expect(res.body.results[1]).to.deep.include({ ok: false, kind: 'assignment.grant' });
      expect(res.body.results[1].error.code).to.equal('forbidden');
      expect(await assignments('?subject=user:carol')).to.deep.equal([]);
    });

    it('answers 403 for a guard refusal', async () => {
      const res = await commands(bob, { commands: [grant('carol', 'superuser')] });
      expect(res.status).to.equal(403);
      expect(res.body.results[0].error.code).to.equal('escalation');
    });

    it('answers 404 for a command on a row that does not exist', async () => {
      const res = await commands(root, { commands: [{ kind: 'assignment.revoke', id: 'nope' }] });
      expect(res.status).to.equal(404);
      expect(res.body.results[0].error.code).to.equal('not_found');
    });

    it('answers 409 for a conflict', async () => {
      const put = (scope: typeof P1) => ({ kind: 'rule.put', rule: { id: 'thr', kind: 'threshold', scope, permissions: ['file:edit'], minRole: 'editor' } });
      expect((await commands(root, { commands: [put(P1)] })).status).to.equal(200);
      const res = await commands(root, { commands: [put(P2)] });
      expect(res.status).to.equal(409);
      expect(res.body.results[0].error.code).to.equal('conflict');
    });

    it('answers a retried batch with the results of the first', async () => {
      const first = await commands(root, { commands: [grant('carol')], idempotencyKey: 'k1' });
      const again = await commands(root, { commands: [grant('carol')], idempotencyKey: 'k1' });
      expect(again.status).to.equal(200);
      expect(again.body).to.deep.equal(first.body);
    });

    it('answers 400 for a validation failure', async () => {
      const res = await commands(root, { commands: [grant('carol', 'ghost')] });
      expect(res.status).to.equal(400);
      expect(res.body.results[0].error.code).to.equal('unknown_role');
    });

    it('answers 400 invalid_batch for a batch over authz.admin.maxBatch, which AuthzAdmin enforces', async () => {
      const res = await commands(root, { commands: Array.from({ length: 101 }, (_, i) => grant(`u${i}`)) });
      expect(res.status).to.equal(400);
      expect(res.body.error.code).to.equal('invalid_batch');
      expect(res.body.results).to.equal(undefined);
      expect(await assignments('?subject=user:u0')).to.deep.equal([]);
    });

    it('answers 400 for a body that is not an object, or commands that are not a list', async () => {
      const list = await commands(root, [grant('carol')]);
      expect(list.status).to.equal(400);
      expect(list.body.error.code).to.equal('invalid_request');
      const notList = await commands(root, { commands: grant('carol') });
      expect(notList.status).to.equal(400);
      expect(notList.body.error.code).to.equal('invalid_batch');
    });

    it('passes the options through to AuthzAdmin, which checks them', async () => {
      const bad = await commands(root, { commands: [grant('carol')], dryRun: 'yes' });
      expect(bad.status).to.equal(400);
      expect(bad.body.error).to.deep.include({ code: 'invalid_batch', field: 'dryRun' });
      const dry = await commands(root, { commands: [grant('carol')], dryRun: true, reason: 'try' });
      expect(dry.status).to.equal(200);
      expect(await assignments('?subject=user:carol')).to.deep.equal([]);
    });

    it('turns ISO dates into Dates at the expiry paths; a bad date is refused by AuthzAdmin', async () => {
      const ok = await commands(root, {
        commands: [
          { ...grant('carol'), expiresAt: LATER },
          { kind: 'set.addMember', set: { role: 'group.member', scope: G1 }, member: { type: 'user', id: 'carol' }, expiresAt: LATER },
          { kind: 'link.create', scope: P1, role: 'viewer', expiresAt: LATER },
          { kind: 'rule.put', rule: { id: 'thr', kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor', expiresAt: LATER } },
        ],
      });
      expect(ok.status, JSON.stringify(ok.body)).to.equal(200);
      const [linkResult] = ok.body.results.slice(2);
      expect(linkResult.token).to.be.a('string');
      const rows = await assignments('?subject=user:carol');
      expect(rows.map((r) => r.expiresAt)).to.deep.equal([LATER, LATER]);
      const update = await commands(root, {
        commands: [
          { kind: 'link.update', id: linkResult.id, expiresAt: '2028-01-01T00:00:00Z' },
          { kind: 'assignment.setExpiry', id: rows[0].id, expiresAt: '2028-01-01T00:00:00Z' },
        ],
      });
      expect(update.status, JSON.stringify(update.body)).to.equal(200);
      const rule = await call('GET', '/authz/rules?scope=project:p1');
      expect(rule.body.items[0].expiresAt).to.equal(LATER);

      for (const bad of ['2027-01-01', 'next year']) {
        const res = await commands(root, { commands: [{ ...grant('carol', 'editor'), expiresAt: bad }] });
        expect(res.status, bad).to.equal(400);
        expect(res.body.results[0].error).to.deep.include({ code: 'invalid_command', field: 'expiresAt' });
      }
    });
  });

  describe('assignments', () => {
    it('lists with scope, subject, role, includeExpired and a page', async () => {
      await commands(root, { commands: [grant('carol'), grant('carol', 'editor', F1), { kind: 'assignment.grant', subject: { set: { role: 'group.member', scope: G1 } }, role: 'viewer', scope: P2 }] });
      expect((await assignments('?scope=project:p1&subject=user:carol')).map((r) => r.role)).to.deep.equal(['viewer']);
      expect((await assignments('?subject=user:carol&role=editor')).map((r) => r.scope)).to.deep.equal([F1]);
      expect((await assignments('?subject=set:group.member@group:g1')).map((r) => r.scope)).to.deep.equal([P2]);
      expect((await assignments(`?scope=${encodeURIComponent('file:uploads:a/b.pdf')}`)).map((r) => r.id)).to.deep.equal(['u1']);
      expect((await assignments('?scope=$global&subject=user:root')).map((r) => r.id).sort()).to.deep.equal(['r1', 'r2']);
      const page = await call('GET', '/authz/assignments?subject=user:carol&limit=1&offset=1&includeExpired=false');
      expect(page.status).to.equal(200);
      expect(page.body.items).to.have.length(1);
      expect(page.body.total).to.equal(2);
    });

    it('answers 400 invalid_query for a malformed query value', async () => {
      for (const [q, field] of [
        ['scope=project:', 'scope'],
        ['subject=alice', 'subject'],
        ['includeExpired=1', 'includeExpired'],
        ['limit=x', 'limit'],
        ['role=a&role=b', 'role'],
      ]) {
        const res = await call('GET', `/authz/assignments?${q}`);
        expect(res.status, q).to.equal(400);
        expect(res.body.error, q).to.deep.include({ code: 'invalid_query', field });
      }
      const zero = await call('GET', '/authz/assignments?limit=0');
      expect(zero.status).to.equal(400);
      expect(zero.body.error.code).to.equal('invalid_query');
    });

    it('answers 403 when the principal may not read', async () => {
      const res = await call('GET', '/authz/assignments', carol);
      expect(res.status).to.equal(403);
      expect(res.body.error.code).to.equal('forbidden');
    });

    it('POST grants one assignment; DELETE revokes it', async () => {
      const res = await call('POST', '/authz/assignments?reason=onboarding', bob, { subject: { type: 'user', id: 'carol' }, role: 'viewer', scope: P1, expiresAt: LATER, kind: 'assignment.revoke' });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.results).to.have.length(1);
      expect(res.body.results[0]).to.include({ ok: true, kind: 'assignment.grant' });
      const [row] = await assignments('?subject=user:carol');
      expect(row.expiresAt).to.equal(LATER);
      const del = await call('DELETE', `/authz/assignments/${encodeURIComponent(row.id)}`, bob);
      expect(del.status).to.equal(200);
      expect(del.body.results[0]).to.include({ ok: true, kind: 'assignment.revoke' });
      expect(await assignments('?subject=user:carol')).to.deep.equal([]);
    });

    it('POST answers the status of a refused grant', async () => {
      expect((await call('POST', '/authz/assignments', bob, grantBody('viewer', P2))).status).to.equal(403);
      expect((await call('POST', '/authz/assignments', root, grantBody('ghost', P1))).status).to.equal(400);
      expect((await call('DELETE', '/authz/assignments/nope', root)).status).to.equal(404);
    });

    it('a dry run from the query string changes nothing; a bad dryRun is 400', async () => {
      const dry = await call('POST', '/authz/assignments?dryRun=true', root, grantBody('viewer', P1));
      expect(dry.status).to.equal(200);
      expect(await assignments('?subject=user:carol')).to.deep.equal([]);
      const bad = await call('POST', '/authz/assignments?dryRun=maybe', root, grantBody('viewer', P1));
      expect(bad.status).to.equal(400);
      expect(bad.body.error).to.deep.include({ code: 'invalid_query', field: 'dryRun' });
    });

    it('PATCH runs setTags, addTags, removeTags and setExpiry in one batch, in that order', async () => {
      const created = await commands(root, { commands: [grant('carol')] });
      const id = created.body.results[0].id as string;
      const res = await call('PATCH', `/authz/assignments/${id}`, root, { expiresAt: LATER, removeTags: ['a'], addTags: ['c'], tags: ['a', 'b'] });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.results.map((r: { kind: string }) => r.kind)).to.deep.equal(['assignment.setTags', 'assignment.addTags', 'assignment.removeTags', 'assignment.setExpiry']);
      const [row] = await assignments('?subject=user:carol');
      expect([...row.tags].sort()).to.deep.equal(['b', 'c']);
      expect(row.expiresAt).to.equal(LATER);

      const clear = await call('PATCH', `/authz/assignments/${id}`, root, { expiresAt: null });
      expect(clear.status).to.equal(200);
      expect(clear.body.results.map((r: { kind: string }) => r.kind)).to.deep.equal(['assignment.setExpiry']);
      expect((await assignments('?subject=user:carol'))[0].expiresAt).to.equal(null);
    });

    it('PATCH refuses a key it does not serve with 400 invalid_request and changes nothing', async () => {
      const res = await call('PATCH', '/authz/assignments/u1', root, { role: 'editor' });
      expect(res.status).to.equal(400);
      expect(res.body.error).to.deep.include({ code: 'invalid_request', field: 'role' });
      const rows = await assignments('?subject=user:alice');
      expect(rows).to.have.length(1);
      expect(rows[0]).to.deep.include({ id: 'u1', role: 'viewer' });
    });

    it('PATCH refuses an empty patch with 400 and answers the status of a failed command', async () => {
      const empty = await call('PATCH', '/authz/assignments/u1', root, {});
      expect(empty.status).to.equal(400);
      expect(empty.body.error.code).to.equal('invalid_request');
      const missing = await call('PATCH', '/authz/assignments/nope', root, { tags: ['a'] });
      expect(missing.status).to.equal(404);
      expect(missing.body.results[0].error.code).to.equal('not_found');
    });
  });

  describe('rules', () => {
    const rule = { kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor' };

    it('PUT puts the rule under the path id, GET lists it, DELETE deletes it', async () => {
      const put = await call('PUT', '/authz/rules/thr', root, rule);
      expect(put.status, JSON.stringify(put.body)).to.equal(200);
      expect(put.body.results[0]).to.include({ ok: true, kind: 'rule.put' });
      const same = await call('PUT', '/authz/rules/thr', root, { ...rule, id: 'thr' });
      expect(same.status).to.equal(200);
      const list = await call('GET', '/authz/rules?scope=project:p1&limit=10');
      expect(list.status).to.equal(200);
      expect(list.body.items.map((r: { id: string }) => r.id)).to.deep.equal(['thr']);
      expect(list.body.total).to.equal(1);
      const del = await call('DELETE', '/authz/rules/thr', root);
      expect(del.status).to.equal(200);
      expect(del.body.results[0]).to.include({ ok: true, kind: 'rule.delete' });
      expect((await call('GET', '/authz/rules')).body.items).to.deep.equal([]);
    });

    it('PUT refuses a body id that is not the path id', async () => {
      const res = await call('PUT', '/authz/rules/thr', root, { ...rule, id: 'other' });
      expect(res.status).to.equal(400);
      expect(res.body.error).to.deep.include({ code: 'invalid_request', field: 'id' });
      expect((await call('GET', '/authz/rules')).body.items).to.deep.equal([]);
    });

    it('PUT answers the status of a refused rule', async () => {
      const res = await call('PUT', '/authz/rules/thr', bob, rule);
      expect(res.status).to.equal(403);
    });
  });

  describe('policies', () => {
    const policy = { effect: 'deny', permissions: ['file:read'], scope: O1, expiresAt: LATER };

    it('PUT, GET and DELETE go through AuthzAdmin to the policy handler and reader', async () => {
      const put = await call('PUT', '/authz/policies/p1?reason=why', root, policy);
      expect(put.status, JSON.stringify(put.body)).to.equal(200);
      expect(put.body.results[0]).to.include({ ok: true, kind: 'policy.put', id: 'p1' });
      const [c] = policyCommands as Extract<AuthzCommand, { kind: 'policy.put' }>[];
      expect(c.policy.id).to.equal('p1');
      expect(c.policy.expiresAt).to.be.instanceOf(Date);
      expect((c.policy.expiresAt as Date).toISOString()).to.equal(LATER);

      const list = await call('GET', '/authz/policies?scope=org:o1&limit=5&offset=0');
      expect(list.status).to.equal(200);
      expect(list.body).to.deep.equal({ items: [{ id: 'p1' }], total: 1 });
      expect(policyQueries).to.deep.equal([{ kind: 'policies', scope: O1, page: { limit: 5, offset: 0 } }]);

      const del = await call('DELETE', '/authz/policies/p1', root);
      expect(del.status).to.equal(200);
      expect(policyCommands[1]).to.deep.equal({ kind: 'policy.delete', id: 'p1' });
    });

    it('PUT refuses a body id that is not the path id, and a bad date reaches the handler as a string', async () => {
      expect((await call('PUT', '/authz/policies/p1', root, { ...policy, id: 'p2' })).status).to.equal(400);
      const bad = await call('PUT', '/authz/policies/p1', root, { ...policy, expiresAt: 'soon' });
      expect(bad.status).to.equal(400);
      expect(bad.body.results[0].error).to.deep.include({ code: 'invalid_command', field: 'policy.expiresAt' });
      expect(policyCommands).to.deep.equal([]);
    });

    it('answers 403 for a principal without the permission', async () => {
      expect((await call('PUT', '/authz/policies/p1', carol, policy)).status).to.equal(403);
      expect((await call('GET', '/authz/policies', carol)).status).to.equal(403);
    });
  });

  describe('scope attributes', () => {
    it('PATCH merges, PUT replaces, GET reads, all through AuthzAdmin', async () => {
      const patch = await call('PATCH', '/authz/scopes/org/o1/attributes', root, { policies: { public_links: false } });
      expect(patch.status, JSON.stringify(patch.body)).to.equal(200);
      expect(patch.body.results[0]).to.include({ ok: true, kind: 'scope.setAttributes' });
      const read = await call('GET', '/authz/scopes/org/o1/attributes');
      expect(read.status, JSON.stringify(read.body)).to.equal(200);
      expect(JSON.stringify(read.body.items)).to.include('public_links');
      const put = await call('PUT', '/authz/scopes/org/o1/attributes', root, { policies: { public_links: true } });
      expect(put.status).to.equal(200);
      expect(put.body.results[0]).to.include({ ok: true, kind: 'scope.replaceAttributes' });
    });

    it('answers 400 for a patch that breaks the schema and 403 without the permission', async () => {
      const bad = await call('PATCH', '/authz/scopes/org/o1/attributes', root, { policies: { public_links: 'sometimes' } });
      expect(bad.status).to.equal(400);
      expect(bad.body.results[0].error.code).to.equal('invalid_attributes');
      expect((await call('PATCH', '/authz/scopes/org/o1/attributes', carol, { policies: { public_links: false } })).status).to.equal(403);
    });
  });

  describe('links', () => {
    const linkBody = { scope: P1, role: 'viewer', expiresAt: LATER };
    const create = async (as: Principal = root, query = ''): Promise<RawResponse> => call('POST', `/authz/links${query}`, as, linkBody);
    const created = async (): Promise<{ id: string; token: string }> => {
      const res = await create();
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      return res.body.results[0];
    };
    const links = async (query = ''): Promise<any[]> => {
      const res = await call('GET', `/authz/links${query}`);
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      return res.body.items;
    };
    const noStore = (res: RawResponse, what: string) => {
      expect(res.headers['cache-control'], what).to.equal('no-store');
      expect(res.headers.pragma, what).to.equal('no-cache');
    };

    it('POST creates a link and answers its token once, with Cache-Control: no-store', async () => {
      const logs = captureLogs();
      let res: RawResponse;
      try {
        res = await create(root, '?reason=share');
      } finally {
        logs.restore();
      }
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      noStore(res, 'POST /authz/links');
      expect(res.body.results).to.have.length(1);
      const [r] = res.body.results;
      expect(r).to.include({ ok: true, kind: 'link.create', affected: 1 });
      expect(r.id).to.be.a('string');
      expect(r.token).to.be.a('string').that.is.not.empty;

      const listed = await links();
      expect(listed.map((l) => l.id)).to.deep.equal([r.id]);
      expect(listed[0]).to.deep.include({ scope: P1, expiresAt: LATER });
      const absent = (where: string, value: unknown) => expect(JSON.stringify(value ?? null), where).to.not.include(r.token);
      absent('GET /authz/links', listed);
      absent('the log lines', logs.lines);
      absent('the audit entries', session?.audit?.entries);
      absent('the published changes', session?.bus?.published);
      absent('the AuthzEvents', session?.lane?.adminEvents?.events);
      expect(session?.lane?.adminEvents?.events.map((e) => e.type)).to.include('LinkCreated');
    });

    it('POST /authz/commands answers with Cache-Control: no-store, the link token in its results', async () => {
      const res = await commands(root, { commands: [{ kind: 'link.create', ...linkBody }] });
      expect(res.status).to.equal(200);
      noStore(res, 'a link.create batch');
      expect(res.body.results[0].token).to.be.a('string').that.is.not.empty;
      expect(JSON.stringify(await links())).to.not.include(res.body.results[0].token);
      noStore(await commands(root, { commands: [grant('carol')] }), 'a batch without links');
      noStore(await commands(carol, { commands: [grant('carol')] }), 'a refused batch');
      noStore(await commands(root, [grant('carol')]), 'a body that is not an object');
    });

    it('answers every refused POST /authz/links with Cache-Control: no-store', async () => {
      const refused = await create(carol);
      expect(refused.status).to.equal(403);
      expect(refused.body.results[0].error.code).to.equal('forbidden');
      noStore(refused, '403');
      const badQuery = await create(root, '?dryRun=maybe');
      expect(badQuery.status).to.equal(400);
      expect(badQuery.body.error).to.deep.include({ code: 'invalid_query', field: 'dryRun' });
      noStore(badQuery, '400 invalid_query');
      const notObject = await call('POST', '/authz/links', root, [linkBody]);
      expect(notObject.status).to.equal(400);
      expect(notObject.body.error.code).to.equal('invalid_request');
      noStore(notObject, '400 invalid_request');
      expect(await links()).to.deep.equal([]);
    });

    it('a dry run answers what AuthzAdmin answers, without a token, and creates nothing', async () => {
      const res = await create(root, '?dryRun=true');
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      const inProcess = await session!.admin!.execute(root, [{ kind: 'link.create', ...linkBody, expiresAt: new Date(LATER) }], { dryRun: true });
      expect(Object.keys(res.body.results[0]).sort()).to.deep.equal(Object.keys(inProcess[0]).sort());
      expect(res.body.results[0]).to.not.have.property('token');
      expect(await links()).to.deep.equal([]);
    });

    it('a retried POST with the same idempotency key answers the first result without its token', async () => {
      const first = await create(root, '?idempotencyKey=k1');
      const again = await create(root, '?idempotencyKey=k1');
      expect(again.status).to.equal(200);
      expect(again.body.results[0].id).to.equal(first.body.results[0].id);
      expect(again.body.results[0]).to.not.have.property('token');
      expect(await links()).to.have.length(1);
    });

    it('GET lists with scope and a page; a malformed query is 400 invalid_query; no read permission is 403', async () => {
      await created();
      await call('POST', '/authz/links', root, { scope: P2, role: 'viewer' });
      expect((await links('?scope=project:p2')).map((l) => l.scope)).to.deep.equal([P2]);
      const page = await call('GET', '/authz/links?limit=1&offset=1');
      expect(page.body.items).to.have.length(1);
      expect(page.body.total).to.equal(2);
      const bad = await call('GET', '/authz/links?scope=project:');
      expect(bad.status).to.equal(400);
      expect(bad.body.error).to.deep.include({ code: 'invalid_query', field: 'scope' });
      const refused = await call('GET', '/authz/links', carol);
      expect(refused.status).to.equal(403);
      expect(refused.body.error.code).to.equal('forbidden');
    });

    it('PATCH updates the expiry, attributes, role and tags through AuthzAdmin', async () => {
      const { id } = await created();
      const res = await call('PATCH', `/authz/links/${id}?reason=extend`, root, { id, expiresAt: '2028-01-01T00:00:00Z', attributes: { note: 'n' }, role: 'editor', tags: ['t'] });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.results).to.have.length(1);
      expect(res.body.results[0]).to.include({ ok: true, kind: 'link.update', id, affected: 1 });
      expect(res.body.results[0]).to.not.have.property('token');
      const [link] = await links();
      expect(link).to.deep.include({ id, expiresAt: '2028-01-01T00:00:00.000Z', attributes: { note: 'n' } });
      const [grantRow] = await assignments(`?subject=link:${id}`);
      expect(grantRow).to.deep.include({ role: 'editor', tags: ['t'] });
      expect(session?.lane?.adminEvents?.events.map((e) => e.type)).to.include('LinkUpdated');
    });

    it('PATCH refuses unknown keys, a body id that is not the path id and an empty patch with 400 invalid_request', async () => {
      const { id } = await created();
      for (const [body, field] of [
        [{ token: 'x' }, 'token'],
        [{ scope: P2 }, 'scope'],
        [{ id: 'other', role: 'editor' }, 'id'],
      ] as const) {
        const res = await call('PATCH', `/authz/links/${id}`, root, body);
        expect(res.status, JSON.stringify(body)).to.equal(400);
        expect(res.body.error, JSON.stringify(body)).to.deep.include({ code: 'invalid_request', field });
      }
      for (const body of [{}, { id }, [{ role: 'editor' }]]) {
        const res = await call('PATCH', `/authz/links/${id}`, root, body);
        expect(res.status, JSON.stringify(body)).to.equal(400);
        expect(res.body.error.code, JSON.stringify(body)).to.equal('invalid_request');
      }
      expect((await assignments(`?subject=link:${id}`))[0].role).to.equal('viewer');
    });

    it('PATCH answers the status of a failed command: a bad date 400, no permission 403, an unknown id 404', async () => {
      const { id } = await created();
      const bad = await call('PATCH', `/authz/links/${id}`, root, { expiresAt: 'soon' });
      expect(bad.status).to.equal(400);
      expect(bad.body.results[0].error).to.deep.include({ code: 'invalid_command', field: 'expiresAt' });
      const refused = await call('PATCH', `/authz/links/${id}`, carol, { expiresAt: LATER });
      expect(refused.status).to.equal(403);
      expect(refused.body.results[0].error.code).to.equal('forbidden');
      const missing = await call('PATCH', '/authz/links/nope', root, { expiresAt: LATER });
      expect(missing.status).to.equal(404);
      expect(missing.body.results[0].error).to.deep.include({ code: 'not_found', field: 'id' });
      const dry = await call('PATCH', `/authz/links/${id}?dryRun=true`, root, { role: 'editor' });
      expect(dry.status).to.equal(200);
      expect((await assignments(`?subject=link:${id}`))[0].role).to.equal('viewer');
    });

    it('DELETE revokes the link through AuthzAdmin: 403 without the permission, 404 for an unknown id', async () => {
      const { id } = await created();
      const refused = await call('DELETE', `/authz/links/${id}`, carol);
      expect(refused.status).to.equal(403);
      expect(refused.body.results[0].error.code).to.equal('forbidden');
      expect((await call('DELETE', `/authz/links/${id}?dryRun=maybe`, root)).status).to.equal(400);
      const missing = await call('DELETE', '/authz/links/nope', root);
      expect(missing.status).to.equal(404);
      expect(missing.body.results[0].error.code).to.equal('not_found');
      const del = await call('DELETE', `/authz/links/${id}?reason=done`, root);
      expect(del.status, JSON.stringify(del.body)).to.equal(200);
      expect(del.body.results[0]).to.include({ ok: true, kind: 'link.revoke', id });
      expect(await links()).to.deep.equal([]);
      expect(await assignments(`?subject=link:${id}`)).to.deep.equal([]);
    });
  });

  describe('domain', () => {
    it('reads authz.http.admin.domain on each call: root when absent, else that domain', async () => {
      const cfg = testHost.config();
      const before = cfg.get<unknown>(['authz', 'http', 'admin', 'domain']);
      try {
        expect(adminDomain()).to.equal(DOMAIN);
        const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
        expect(await domainAdmin()).to.equal((await domains.service(DOMAIN)).admin());

        cfg.unset(['authz', 'http', 'admin', 'domain']);
        expect(adminDomain()).to.equal('root');
        expect(await domainAdmin()).to.equal(((await DI.resolve(AuthzService)) as AuthzService).admin());

        for (const bad of ['', 7, null]) {
          cfg.set(['authz', 'http', 'admin', 'domain'], bad);
          expect(() => adminDomain(), String(bad)).to.throw(AuthzConfigError);
        }
        cfg.set(['authz', 'http', 'admin', 'domain'], '');
        const failed = await commands(root, { commands: [grant('carol')] });
        expect(failed.status).to.equal(500);
        expect(failed.headers['cache-control'], 'a 500 of POST /authz/commands').to.equal('no-store');
        const failedLink = await call('POST', '/authz/links', root, { scope: P1, role: 'viewer' });
        expect(failedLink.status).to.equal(500);
        expect(failedLink.headers['cache-control'], 'a 500 of POST /authz/links').to.equal('no-store');
      } finally {
        cfg.set(['authz', 'http', 'admin', 'domain'], before);
      }
      expect((await commands(root, { commands: [grant('carol')] })).status).to.equal(200);
    });
  });
});

function grantBody(roleName: string, scope = P1) {
  return { subject: { type: 'user', id: 'carol' }, role: roleName, scope };
}
