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
      assignment('a-carol-direct', carol, 'viewer', P1),
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
    session = await harness.setup(world, { id: 'B26', part: 'holders', case: 'holders', title: 'holders', facets: ['engine', 'admin', 'rbac', 'audit'] });
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
    expect(total).to.equal(4);
    expect(byKey[subjectKey('alice')].via).to.deep.equal([{ role: 'viewer', scope: P1, assignment: 'a-alice' }]);
    expect(byKey[subjectKey('alice')].decision).to.deep.equal({ allowed: true, conditional: false });
    expect(byKey[subjectKey('bob')].decision).to.include({ allowed: false, reason: 'role_denied' });
    expect(byKey[JSON.stringify(TEAM_SET)].decision).to.equal(undefined);
  });

  it('verifies without leaving an access-attempt trace: no deny audit for a listed holder', async () => {
    const { items } = await holders();
    expect((items as Holder[]).find((h) => JSON.stringify(h.subject) === subjectKey('bob'))?.decision?.allowed).to.equal(false);
    const denials = session.audit!.entries.filter((e) => e.kind === 'deny');
    expect(denials.filter((e) => (e as { principal?: { id?: string } }).principal?.id === 'bob')).to.deep.equal([]);
  });

  it('lists the holders of a permission granted at $global', async () => {
    const { items, total } = await holders({}, GLOBAL, 'authz:holders.read');
    expect(total).to.equal(1);
    expect(JSON.stringify((items[0] as Holder).subject)).to.equal(subjectKey('root'));
    expect((items[0] as Holder).decision?.allowed).to.equal(true);
  });

  it('merges a subject that holds directly and through a set into one entry with both via', async () => {
    const { items } = await holders({ expandSets: true });
    const found = (items as Holder[]).filter((h) => JSON.stringify(h.subject) === subjectKey('carol'));
    expect(found).to.have.length(1);
    expect(found[0].via.map((v) => v.set !== undefined)).to.have.members([true, false]);
  });

  it('expands sets to their members', async () => {
    const { items } = await holders({ expandSets: true });
    const found = (items as Holder[]).find((h) => JSON.stringify(h.subject) === subjectKey('carol'));
    expect(found?.via.find((v) => v.set)?.set).to.deep.equal(TEAM_SET.set);
    expect(found?.decision?.allowed).to.equal(true);
  });

  it('pages a stable order and refuses an actor without authz:holders.read', async () => {
    const everyone = await holders();
    const first = await holders({ page: { limit: 2, offset: 0 } });
    const second = await holders({ page: { limit: 2, offset: 2 } });
    expect(first.items).to.have.length(2);
    expect(second.items).to.have.length(2);
    expect(first.total).to.equal(4);
    const keys = (r: { items: readonly unknown[] }) => (r.items as Holder[]).map((h) => JSON.stringify(h.subject));
    expect([...keys(first), ...keys(second)]).to.deep.equal(keys(everyone));
    expect(new Set([...keys(first), ...keys(second)]).size).to.equal(4);
    expect(await rejection(holders({}, D1, 'doc:read', alice))).to.equal('forbidden');
  });

  it('refuses an unknown permission, an unknown resource (denied by the actor check first) and a permission not checked on the scope type', async () => {
    expect(await rejection(holders({}, D1, 'doc:nope'))).to.equal('invalid_query');
    expect(await rejection(holders({}, ref('doc', 'missing')))).to.equal('forbidden');
    expect(await rejection(holders({}, T1))).to.equal('invalid_query');
  });
});

const L1 = ref('project', 'l1');
const LD = ref('doc', 'ld');
const filterWorld: World = {
  now: world.now,
  permissions: [
    { name: 'doc:read', types: ['doc', 'project'] },
    { name: 'doc:edit', types: ['doc', 'project'] },
    { name: 'authz:holders.read', types: ['doc', 'project', 'team', '$global'] },
  ],
  principals: people,
  scopes: [{ nodes: [{ ref: L1 }, { ref: LD, parent: L1 }, { ref: T1 }] }],
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [
      role('viewer', ['doc:read']),
      role('lead', [], { implies: [{ role: 'viewer', at: 'descendants' }] }),
      role('projviewer', [{ permission: 'doc:read', grantedAt: ['project'] }]),
      role('tagged', [{ permission: 'doc:read', requiresTag: 'vip' }]),
      role('wrongdoc', [{ permission: 'doc:read', on: [{ type: 'doc', id: 'other' }] }]),
      role('auditor', ['authz:holders.read']),
      role('team.member', [], { subjectSet: true }),
    ],
    assignments: [
      assignment('f-root', root, 'auditor', GLOBAL),
      assignment('f-alice-lead-doc', alice, 'lead', LD),
      assignment('f-bob-lead-project', bob, 'lead', L1),
      assignment('f-carol-pv-doc', carol, 'projviewer', LD),
      assignment('f-dave-pv-project', dave, 'projviewer', L1),
      assignment('f-alice-tagged', alice, 'tagged', L1),
      assignment('f-bob-wrongdoc', bob, 'wrongdoc', L1),
      { id: 'f-set-lead-doc', subject: TEAM_SET, role: 'lead', scope: LD, source: 'test' },
      { id: 'f-set-viewer-project', subject: { set: { role: 'team.member', scope: T1 } }, role: 'viewer', scope: L1, source: 'test' },
      { id: 'f-link', subject: { type: 'link', id: 'lnk1' }, role: 'viewer', scope: LD, source: 'test' },
      { id: 'f-any', subject: { type: 'user', id: '*' }, role: 'viewer', scope: LD, source: 'test' },
    ] as Assignment[],
  },
};

describe('holders query: assignments that cannot give the permission here are not listed', function () {
  this.timeout(30000);
  const harness = rbacAdminHarness({});
  let session: HarnessSession;
  let admin: AuthzAdmin;

  before(async () => {
    await harness.beforeAll?.();
  });
  after(async () => {
    await harness.afterAll?.();
  });
  beforeEach(async () => {
    session = await harness.setup(filterWorld, { id: 'B26', part: 'holders', case: 'holders-filter', title: 'holders-filter', facets: ['engine', 'admin', 'rbac', 'audit'] });
    admin = session.admin as AuthzAdmin;
  });
  afterEach(async () => {
    await session?.dispose();
  });

  const list = async () => (await admin.list(root, { kind: 'holders', scope: LD, permission: 'doc:read' })).items as Holder[];
  const assignmentsOf = (items: Holder[]) => items.flatMap((h) => h.via.map((v) => v.assignment)).sort();

  it('does not list a role whose implied role applies to descendants only, assigned on the resource itself, but lists it on an ancestor', async () => {
    const ids = assignmentsOf(await list());
    expect(ids).to.not.include('f-alice-lead-doc');
    expect(ids).to.include('f-bob-lead-project');
  });

  it('does not list a grantedAt-limited grant assigned at a scope type it does not name', async () => {
    const ids = assignmentsOf(await list());
    expect(ids).to.not.include('f-carol-pv-doc');
    expect(ids).to.include('f-dave-pv-project');
  });

  it('does not list a grant whose on pattern excludes the resource, and keeps a tag-conditional one', async () => {
    const ids = assignmentsOf(await list());
    expect(ids).to.not.include('f-bob-wrongdoc');
    expect(ids).to.include('f-alice-tagged');
  });

  it('applies the same filters to a set subject', async () => {
    const items = await list();
    const set = items.find((h) => JSON.stringify(h.subject) === JSON.stringify(TEAM_SET));
    expect(set?.via.map((v) => v.assignment)).to.deep.equal(['f-set-viewer-project']);
  });

  it('gives a link and a wildcard subject no decision, and lists them', async () => {
    const items = await list();
    const link = items.find((h) => (h.subject as { type?: string }).type === 'link');
    const any = items.find((h) => (h.subject as { id?: string }).id === '*');
    expect(link, 'link listed').to.not.equal(undefined);
    expect(link!.decision).to.equal(undefined);
    expect(any, 'wildcard listed').to.not.equal(undefined);
    expect(any!.decision).to.equal(undefined);
  });
});

const ladderWorld: World = {
  now: world.now,
  permissions: [
    { name: 'doc:read', types: ['doc', 'project'] },
    { name: 'authz:holders.read', types: ['doc', 'project', '$global'] },
  ],
  principals: people,
  scopes: [{ nodes: [{ ref: P1 }, { ref: D1, parent: P1 }] }],
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: {
    ladders: [{ name: 'proj', roles: ['pviewer', 'peditor'] }],
    roles: [
      { ...role('pviewer', [{ permission: 'doc:read', grantedAt: ['project'] }]), ladder: 'proj' },
      { ...role('peditor', []), ladder: 'proj' },
      role('lead', [], { implies: [{ role: 'peditor', at: 'self-and-descendants' }] }),
      role('auditor', ['authz:holders.read']),
    ],
    assignments: [assignment('l-root', root, 'auditor', GLOBAL), assignment('l-alice', alice, 'lead', P1)],
  },
};

describe('holders query: an implied ladder role supplies the rank of a grantedAt grant', function () {
  this.timeout(30000);
  const harness = rbacAdminHarness({});
  let session: HarnessSession;

  before(async () => {
    await harness.beforeAll?.();
  });
  after(async () => {
    await harness.afterAll?.();
  });
  beforeEach(async () => {
    session = await harness.setup(ladderWorld, { id: 'B26', part: 'holders', case: 'holders-ladder', title: 'holders-ladder', facets: ['engine', 'admin', 'rbac', 'audit'] });
  });
  afterEach(async () => {
    await session?.dispose();
  });

  it('lists the holder the engine allows', async () => {
    const { items } = await (session.admin as AuthzAdmin).list(root, { kind: 'holders', scope: D1, permission: 'doc:read' });
    const alice1 = (items as Holder[]).find((h) => JSON.stringify(h.subject) === subjectKey('alice'));
    expect(alice1?.via.map((v) => v.assignment)).to.deep.equal(['l-alice']);
    expect(alice1?.decision?.allowed).to.equal(true);
  });

  it('refuses a page limit above 100 instead of capping it', async () => {
    try {
      await (session.admin as AuthzAdmin).list(root, { kind: 'holders', scope: D1, permission: 'doc:read', page: { limit: 101, offset: 0 } });
      expect.fail('resolved');
    } catch (e) {
      expect(e).to.be.instanceOf(AuthzAdminFailure);
      expect(e).to.include({ code: 'invalid_query', field: 'page.limit' });
    }
  });
});

describe('holders query without a MembershipStore', function () {
  this.timeout(30000);
  const harness = rbacAdminHarness({});
  let session: HarnessSession;

  before(async () => {
    await harness.beforeAll?.();
  });
  after(async () => {
    await harness.afterAll?.();
  });
  beforeEach(async () => {
    session = await harness.setup(world, { id: 'B26', part: 'holders', case: 'holders', title: 'holders', facets: ['engine', 'admin', 'rbac'] });
  });
  afterEach(async () => {
    await session?.dispose();
  });

  it('refuses expandSets with invalid_query on expandSets', async () => {
    try {
      await (session.admin as AuthzAdmin).list(root, { kind: 'holders', scope: D1, permission: 'doc:read', expandSets: true });
      expect.fail('resolved');
    } catch (e) {
      expect(e).to.be.instanceOf(AuthzAdminFailure);
      expect(e).to.include({ code: 'invalid_query', field: 'expandSets' });
    }
  });
});
