import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World, WorldLink } from '@spinajs/authz-testing';

import { GLOBAL } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommand, AuthzCommandResult, AuthzService, Principal } from '@spinajs/authz';

import type { Assignment } from '../../src/index.js';
import { rbacAdminHarness } from './rbac-admin-harness.js';

const expect = chai.expect;
const { ref, role, assignment } = fixtureDsl;

const NOW = new Date('2026-10-03T00:00:00.000Z');
const SOON = new Date(NOW.getTime() + 60_000);
const LATER = new Date(NOW.getTime() + 120_000);
const O1 = ref('org', 'o1');

// users:update is the default privilegedPermission. Every role but admin, admin2 and wide grants it on a
// condition the guard cannot see met at GLOBAL.
const ROLES = [role('admin', ['users:update', 'authz:assignments.manage']), role('admin2', ['users:update']), role('tagged', [{ permission: 'users:update', requiresTag: 'mfa' }]), role('prov', [{ permission: 'users:update', grantedAt: ['org'] }]), role('wide', [{ permission: 'users:update', grantedAt: ['$global'] }]), role('org.boss', ['users:update'], { ladder: 'orgs' }), role('ops', ['authz:assignments.manage']), role('org.member', ['org:read'], { ladder: 'org', subjectSet: true }), role('org.admin', ['org:manage'], { ladder: 'org' })];
const LADDERS = [
  { name: 'org', roles: ['org.member', 'org.admin'] },
  { name: 'orgs', roles: ['org.boss'], resourceTypes: ['org'] },
];

const people = Object.fromEntries(['root', 'root2', 'dave', 'ops'].map((id) => [id, userPrincipal(id)]));
const { root, root2, dave, ops } = people;

const worldOf = (rows: readonly Assignment[], links: readonly WorldLink[] = [], rootRow = assignment('a-root', root, 'admin', GLOBAL)): World => ({
  now: NOW,
  permissions: [{ name: 'users:update' }, { name: 'authz:assignments.manage' }, ...['org:read', 'org:manage'].map((name) => ({ name, types: ['org'] }))],
  principals: people,
  scopes: [{ nodes: [{ ref: O1 }] }],
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: { roles: ROLES, ladders: LADDERS, assignments: [rootRow, assignment('o-ops', ops, 'ops', GLOBAL), ...rows], links },
});

describe('DefaultAdminGuard on the RbacModel: other paths and holders the model may not honour', function () {
  this.timeout(30000);
  const harness = rbacAdminHarness();
  let session: HarnessSession | undefined;
  let admin: AuthzAdmin;
  let authz: AuthzService;

  before(async () => {
    await harness.beforeAll?.();
  });

  after(async () => {
    await harness.afterAll?.();
  });

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
  });

  const open = async (rows: readonly Assignment[], links?: readonly WorldLink[], rootRow?: Assignment) => {
    await session?.dispose();
    session = await harness.setup(worldOf(rows, links, rootRow), { id: 'B26', part: 'guard', case: 'paths', title: 'paths', facets: ['engine', 'admin', 'rbac', 'ladders', 'links'] });
    admin = session.admin as AuthzAdmin;
    authz = session.authz as unknown as AuthzService;
  };
  const holds = async (p: Principal) => {
    const d = await authz.check({ principal: p, permission: 'users:update', resource: GLOBAL });
    return d.allowed && d.residual.op === 'true';
  };
  const code = (results: readonly AuthzCommandResult[]) => (results[0].ok ? 'ok' : results[0].error.code);
  const revoke = (id: string): AuthzCommand => ({ kind: 'assignment.revoke', id });

  describe('self_lockout: a removal on a path is refused whatever other path the actor has', () => {
    // root2 holds admin too, so last_holder does not decide these.
    const cases: [string, Assignment][] = [
      ['an other path that needs a tag', assignment('t-root', root, 'tagged', GLOBAL)],
      ['an other path that needs provenance', assignment('p-root', root, 'prov', GLOBAL)],
      ['an other path that expires soon', assignment('a2-root', root, 'admin2', GLOBAL, { expiresAt: SOON })],
    ];
    for (const [name, other] of cases) {
      it(name, async () => {
        await open([assignment('a-root2', root2, 'admin', GLOBAL), other]);
        expect(code(await admin.execute(root, [revoke('a-root')]))).to.equal('self_lockout');
        expect(await holds(root)).to.equal(true);
      });
    }

    it('the model gives the tag and provenance paths nothing', async () => {
      await open([assignment('t-dave', dave, 'tagged', GLOBAL), assignment('p-root2', root2, 'prov', GLOBAL)]);
      expect([await holds(dave), await holds(root2)]).to.deep.equal([false, false]);
    });
  });

  describe('last_holder: only holders the model surely honours at GLOBAL count', () => {
    it('a share link whose role makes it a member of a set holding the privilege at GLOBAL is no holder', async () => {
      const set = { id: 's-org', subject: { set: { role: 'org.member', scope: O1 } }, role: 'admin', scope: GLOBAL, source: 'test' } as Assignment;
      await open([set], [{ id: 'l1', scope: O1, token: 'tok-l1', role: 'org.admin', attributes: {} }]);
      const link = await session!.lane!.rbacLinks!.principal('tok-l1');
      expect([await holds(root), await holds(link)]).to.deep.equal([true, false]);
      expect(code(await admin.execute(ops, [revoke('a-root')]))).to.equal('last_holder');
      expect(await holds(root)).to.equal(true);
    });

    const unsure: [string, Assignment][] = [
      ['a grant that needs a tag', assignment('t-dave', dave, 'tagged', GLOBAL)],
      ['a grant made only at org scopes', assignment('p-dave', dave, 'prov', GLOBAL)],
      ['a ladder role whose ladder does not apply at GLOBAL', assignment('b-dave', dave, 'org.boss', GLOBAL)],
      ['a holder that expires before the removed row would', assignment('a2-dave', dave, 'admin2', GLOBAL, { expiresAt: SOON })],
    ];
    for (const [name, other] of unsure) {
      it(`${name} is no holder`, async () => {
        await open([other]);
        expect(code(await admin.execute(ops, [revoke('a-root')]))).to.equal('last_holder');
      });
    }

    it('the model agrees: none of those gives users:update at GLOBAL for good', async () => {
      await open([assignment('t-dave', dave, 'tagged', GLOBAL), assignment('p-root2', root2, 'prov', GLOBAL), assignment('b-ops', ops, 'org.boss', GLOBAL)]);
      expect([await holds(dave), await holds(root2), await holds(ops)]).to.deep.equal([false, false, false]);
    });

    it('an unconditional holder, or a grantedAt that lists $global, counts', async () => {
      await open([assignment('w-dave', dave, 'wide', GLOBAL)]);
      expect(await holds(dave)).to.equal(true);
      expect(code(await admin.execute(ops, [revoke('a-root')]))).to.equal('ok');
    });

    it('a holder that lasts at least as long as the removed row counts', async () => {
      const expiring = assignment('a-root', root, 'admin', GLOBAL, { expiresAt: SOON });
      await open([assignment('a2-dave', dave, 'admin2', GLOBAL, { expiresAt: SOON })], [], expiring);
      expect(code(await admin.execute(ops, [revoke('a-root')]))).to.equal('ok');
      await open([assignment('a2-dave', dave, 'admin2', GLOBAL, { expiresAt: new Date(SOON.getTime() - 1000) })], [], expiring);
      expect(code(await admin.execute(ops, [revoke('a-root')]))).to.equal('last_holder');
    });

    it('moving the expiry of the last permanent holder earlier needs another permanent holder', async () => {
      await open([assignment('a2-dave', dave, 'admin2', GLOBAL, { expiresAt: LATER })]);
      expect(code(await admin.execute(ops, [{ kind: 'assignment.setExpiry', id: 'a-root', expiresAt: SOON }]))).to.equal('last_holder');
    });
  });
});
