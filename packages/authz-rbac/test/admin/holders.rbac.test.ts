import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { AuthzAdminFailure, GLOBAL, MemoryAuthzAdminBackend } from '@spinajs/authz';
import type { AuthzAdmin } from '@spinajs/authz';

import { AdminMembershipStore, MembershipStore, MemoryMembershipStore } from '../../src/index.js';
import type { Assignment, Holder } from '../../src/index.js';
import { rbacAdminHarness } from './rbac-admin-harness.js';

const expect = chai.expect;
const { ref, role, assignment } = fixtureDsl;
const { instance } = testHost;

const P1 = ref('project', 'p1');
const D1 = ref('doc', 'd1');
const T1 = ref('team', 't1');
const TEAM_SET = { set: { role: 'team.member', scope: T1 } };

const people = Object.fromEntries(['root', 'alice', 'bob', 'carol', 'dave'].map((id) => [id, userPrincipal(id)]));
const { root, alice, bob, carol, dave } = people;

const setAssignment: Assignment = { id: 'set-viewer', subject: TEAM_SET, role: 'viewer', scope: P1, source: 'test' };

const world: World = {
  now: new Date('2026-10-03T00:00:00.000Z'),
  permissions: [
    { name: 'doc:read', types: ['doc', 'project'] },
    { name: 'authz:holders.read', types: ['doc', 'project', 'team', '$global'] },
  ],
  principals: people,
  scopes: [{ nodes: [{ ref: P1 }, { ref: D1, parent: P1 }, { ref: ref('project', 'p2') }, { ref: T1 }] }],
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('viewer', ['doc:read']), role('blocked', ['doc:read'], { deny: true }), role('auditor', ['authz:holders.read']), role('team.member', [], { subjectSet: true })],
    assignments: [
      assignment('a-root', root, 'auditor', GLOBAL),
      assignment('a-alice', alice, 'viewer', P1),
      assignment('a-bob-view', bob, 'viewer', D1),
      assignment('a-bob-block', bob, 'blocked', P1),
      setAssignment,
      assignment('a-carol', carol, 'team.member', T1),
      assignment('a-dave', dave, 'viewer', ref('project', 'p2')),
    ],
  },
};

const subjectKey = (user: string) => `{"type":"user","id":"${user}"}`;

describe('holders query on the RbacModel', function () {
  this.timeout(30000);
  const harness = rbacAdminHarness({
    register(host) {
      const members = new MemoryMembershipStore();
      host.container.register(instance(members)).as(MembershipStore);
      host.container.register(instance(members)).as(AdminMembershipStore);
      seed = () => new MemoryAuthzAdminBackend().transaction('test', (tx) => members.replace('user:carol', [{ memberKey: 'user:carol', setKey: 'team:t1#team.member', depth: 1, expiresAt: null }], tx));
    },
  });
  let seed: () => Promise<void>;
  let session: HarnessSession;
  let admin: AuthzAdmin;

  before(async () => {
    await harness.beforeAll?.();
  });
  after(async () => {
    await harness.afterAll?.();
  });
  beforeEach(async () => {
    session = await harness.setup(world, { id: 'B26', part: 'holders', case: 'holders', title: 'holders', facets: ['engine', 'admin', 'rbac'] });
    admin = session.admin as AuthzAdmin;
    await seed();
  });
  afterEach(async () => {
    await session?.dispose();
  });

  const rejection = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).to.be.instanceOf(AuthzAdminFailure);
      return (e as AuthzAdminFailure).code;
    }
    return 'resolved';
  };
  const holders = (extra: object = {}, scope = D1, permission = 'doc:read', actor = root) => admin.list(actor, { kind: 'holders', scope, permission, ...extra });

  it('lists the subjects whose roles on the path grant the permission, each verified by a check', async () => {
    const { items, total } = await holders();
    const byKey = Object.fromEntries((items as Holder[]).map((h) => [JSON.stringify(h.subject), h]));
    expect(total).to.equal(3);
    expect(byKey[subjectKey('alice')].via).to.deep.equal([{ role: 'viewer', scope: P1, assignment: 'a-alice' }]);
    expect(byKey[subjectKey('alice')].decision).to.deep.equal({ allowed: true, conditional: false });
    expect(byKey[subjectKey('bob')].decision).to.include({ allowed: false, reason: 'role_denied' });
    expect(byKey[JSON.stringify(TEAM_SET)].decision).to.equal(undefined);
  });

  it('expands sets to their members', async () => {
    const { items } = await holders({ expandSets: true });
    const found = (items as Holder[]).find((h) => JSON.stringify(h.subject) === subjectKey('carol'));
    expect(found?.via[0].set).to.deep.equal(TEAM_SET.set);
    expect(found?.decision?.allowed).to.equal(true);
  });

  it('pages a stable order and refuses an actor without authz:holders.read', async () => {
    const first = await holders({ page: { limit: 2, offset: 0 } });
    const second = await holders({ page: { limit: 2, offset: 2 } });
    expect(first.items).to.have.length(2);
    expect(second.items).to.have.length(1);
    expect(first.total).to.equal(3);
    expect(await rejection(holders({}, D1, 'doc:read', alice))).to.equal('forbidden');
  });

  it('refuses an unknown permission, an unknown resource (denied by the actor check first) and a permission not checked on the scope type', async () => {
    expect(await rejection(holders({}, D1, 'doc:nope'))).to.equal('invalid_query');
    expect(await rejection(holders({}, ref('doc', 'missing')))).to.equal('forbidden');
    expect(await rejection(holders({}, T1))).to.equal('invalid_query');
  });
});
