import { GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import type { Assignment, AssignmentSubject } from '../../src/contracts.js';
import { ManualClock, fakeModelInitContext, groupPrincipal, userPrincipal, withCeiling, withCompanions } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MembershipStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacService } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-17T12:00:00.000Z');
const HOUR = 3_600_000;
const T1: ResourceRef = { type: 'team', id: 't1' };
const T2: ResourceRef = { type: 'team', id: 't2' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const ALICE: AssignmentSubject = { type: 'user', id: 'alice' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly string[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((permission) => ({ permission })) });
const row = (id: string, subject: AssignmentSubject, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}): Assignment => ({ id, subject, role: roleName, scope, source: 'test', ...extra });

const ROLES = [role('team.member', [], { subjectSet: true }), role('team.lead', [], { extends: ['team.member'] }), role('viewer', ['file:read'])];

class FakeMembershipStore extends MembershipStore {
  readonly calls: string[][] = [];
  constructor(private readonly sets: Readonly<Record<string, readonly string[]>>, private readonly ends: Readonly<Record<string, Date>> = {}) {
    super();
  }
  async setsOf(memberKeys: readonly string[]): Promise<readonly { setKey: string; expiresAt?: Date }[]> {
    this.calls.push([...memberKeys]);
    const keys = [...new Set(memberKeys.flatMap((k) => this.sets[k] ?? []))];
    return keys.map((setKey) => (this.ends[setKey] ? { setKey, expiresAt: this.ends[setKey] } : { setKey }));
  }
  async membersOf(setKey: string): Promise<readonly string[]> {
    return Object.keys(this.sets).filter((k) => this.sets[k].includes(setKey));
  }
}

async function setup(rows: readonly Assignment[] = [], membership?: MembershipStore): Promise<RbacService> {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'file:read', types: ['project'] }], 'test');
  registry.freeze();
  const model = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(rows), clock: new ManualClock(NOW), ...(membership ? { membership } : {}), log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  model.grantIndex();
  return new RbacService(model);
}

const expectUnique = (keys: readonly string[]) => expect(new Set(keys).size).to.equal(keys.length);

describe('authz-rbac model: RbacService.subjectKeysOf', () => {
  it('gives the principal, its companions and their wildcards, frozen', async () => {
    const service = await setup();
    const keys = await service.subjectKeysOf(withCompanions(alice, [{ type: 'device', id: 'd1' }]));
    expect(keys).to.have.members(['user:alice', 'device:d1', 'user:*', 'device:*']);
    expectUnique(keys);
    expect(Object.isFrozen(keys)).to.equal(true);
  });

  it("gives a group principal's member set", async () => {
    const service = await setup();
    expect(await service.subjectKeysOf(groupPrincipal('g1'))).to.have.members(['group:g1', 'group:g1#group.member', 'group:*']);
  });

  it('gives the sets live assignments make the principal a member of, through the role closure too', async () => {
    const service = await setup([row('m1', ALICE, 'team.member', T1), row('m2', ALICE, 'team.lead', T2), row('v1', ALICE, 'viewer', P1)]);
    expect(await service.subjectKeysOf(alice)).to.have.members(['user:alice', 'user:*', 'team:t1#team.member', 'team:t2#team.member']);
  });

  it('leaves out an expired membership and reads memberships at `at`', async () => {
    const service = await setup([row('old', ALICE, 'team.member', T1, { expiresAt: new Date(NOW.getTime() - HOUR) }), row('soon', ALICE, 'team.member', T2, { expiresAt: new Date(NOW.getTime() + HOUR) })]);
    expect(await service.subjectKeysOf(alice)).to.have.members(['user:alice', 'user:*', 'team:t2#team.member']);
    expect(await service.subjectKeysOf(alice, new Date(NOW.getTime() + 2 * HOUR))).to.have.members(['user:alice', 'user:*']);
  });

  it('makes no member of an assignment made to a set', async () => {
    const service = await setup([row('n1', { set: { role: 'team.member', scope: T1 } }, 'team.member', T2)]);
    expect(await service.subjectKeysOf(alice)).to.have.members(['user:alice', 'user:*']);
  });

  it('gives nested sets from the MembershipStore, read with the base keys, each key once', async () => {
    const store = new FakeMembershipStore({ 'user:alice': ['team:t1#team.member', 'team:t2#team.member'] });
    const service = await setup([row('m1', ALICE, 'team.member', T1)], store);
    const keys = await service.subjectKeysOf(alice);
    expect(keys).to.have.members(['user:alice', 'user:*', 'team:t1#team.member', 'team:t2#team.member']);
    expectUnique(keys);
    expect(store.calls).to.deep.equal([['user:alice', 'user:*']]);
  });

  it('without a MembershipStore sets stay one level deep', async () => {
    const service = await setup([row('m1', ALICE, 'team.member', T1), row('n1', { set: { role: 'team.member', scope: T1 } }, 'team.member', T2)]);
    expect(await service.subjectKeysOf(alice)).to.have.members(['user:alice', 'user:*', 'team:t1#team.member']);
  });
});

describe('authz-rbac model: RbacService.subjectKeysOf under a ceiling and expiry', () => {
  const CLOSURE = { 'user:alice': ['team:t1#team.member', 'team:t2#team.member'] };

  it('keeps a direct set only through a membership whose role passes ceiling.roles, and no nested set', async () => {
    const service = await setup([row('m1', ALICE, 'team.member', T1)], new FakeMembershipStore(CLOSURE));
    expect(await service.subjectKeysOf(withCeiling(alice, { roles: ['team.member'] }))).to.have.members(['user:alice', 'user:*', 'team:t1#team.member']);
    expect(await service.subjectKeysOf(withCeiling(alice, { roles: ['viewer'] }))).to.have.members(['user:alice', 'user:*']);
  });

  it('keeps a direct set when any of its memberships passes the ceiling', async () => {
    const service = await setup([row('m1', ALICE, 'team.member', T1), row('m2', ALICE, 'team.lead', T1)]);
    expect(await service.subjectKeysOf(withCeiling(alice, { roles: ['team.lead'] }))).to.have.members(['user:alice', 'user:*', 'team:t1#team.member']);
  });

  it("keeps a group principal's member set under a ceiling", async () => {
    const service = await setup();
    expect(await service.subjectKeysOf(withCeiling(groupPrincipal('g1'), { roles: [] }))).to.have.members(['group:g1', 'group:g1#group.member', 'group:*']);
  });

  it('leaves out a nested set whose membership ended at `at`', async () => {
    const store = new FakeMembershipStore(CLOSURE, { 'team:t2#team.member': new Date(NOW.getTime() + HOUR) });
    const service = await setup([row('m1', ALICE, 'team.member', T1)], store);
    expect(await service.subjectKeysOf(alice)).to.have.members(['user:alice', 'user:*', 'team:t1#team.member', 'team:t2#team.member']);
    expect(await service.subjectKeysOf(alice, new Date(NOW.getTime() + 2 * HOUR))).to.have.members(['user:alice', 'user:*', 'team:t1#team.member']);
  });

  it('leaves out an expired nested set a MembershipStore still returns', async () => {
    const store = new FakeMembershipStore(CLOSURE, { 'team:t2#team.member': new Date(NOW.getTime() - HOUR) });
    const service = await setup([row('m1', ALICE, 'team.member', T1)], store);
    expect(await service.subjectKeysOf(alice)).to.have.members(['user:alice', 'user:*', 'team:t1#team.member']);
  });
});
