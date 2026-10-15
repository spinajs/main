import { GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, EvaluationContext, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, userPrincipal, withCeiling } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MembershipStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel, parseSetKey, principalSubjectKey, subjectKeyOf } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-14T12:00:00.000Z');
const P1: ResourceRef = { type: 'project', id: 'p1' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const T1: ResourceRef = { type: 'team', id: 't1' };
const T2: ResourceRef = { type: 'team', id: 't2' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly string[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((permission) => ({ permission })) });
const setOf = (roleName: string, scope: ResourceRef): AssignmentSubject => ({ set: { role: roleName, scope } });
const row = (id: string, subject: AssignmentSubject, roleName: string, scope: ResourceRef = GLOBAL): Assignment => ({ id, subject, role: roleName, scope, source: 'test' });

const ROLES = [role('team.member', [], { subjectSet: true }), role('viewer', ['file:read']), role('blocked', ['file:read'], { deny: true })];
// alice is in t1 by her own row; t1's members are members of t2 (nested); t2's members view P1.
const ROWS = [row('m1', { type: 'user', id: 'alice' }, 'team.member', T1), row('n1', setOf('team.member', T1), 'team.member', T2), row('s1', setOf('team.member', T2), 'viewer', P1)];
const CLOSURE = { 'user:alice': ['team:t1#team.member', 'team:t2#team.member'] };

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

function registry() {
  const r = new PermissionRegistryImpl();
  r.register([{ name: 'file:read', types: ['project', 'file'] }], 'test');
  r.freeze();
  return r;
}

const scopes = new FakeScopeResolver({ types: ['project', 'file', 'team'], nodes: [{ ref: P1 }, { ref: f1, parent: P1 }, { ref: T1 }, { ref: T2 }] });
const ctx = (): EvaluationContext => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

async function model(rows: readonly Assignment[], membership?: MembershipStore): Promise<RbacModel> {
  const m = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(rows), ...(membership ? { membership } : {}), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
  m.grantIndex();
  return m;
}

describe('authz-rbac nested subject sets (design §4.3)', () => {
  it('parseSetKey reads back what subjectKeyOf writes for a set, and nothing for a principal', () => {
    for (const set of [setOf('team.member', T1), setOf('a#b', { type: 'te:am', id: 'x#1*%' }), setOf('admins', GLOBAL), setOf('team.member', { type: 'team' })]) expect(parseSetKey(subjectKeyOf(set))).to.deep.equal(set);
    expect(parseSetKey(subjectKeyOf({ type: 'user', id: 'alice' }))).to.equal(undefined);
    expect(parseSetKey('user:*')).to.equal(undefined);
  });

  it('principalSubjectKey never gives the wildcard', () => {
    expect(principalSubjectKey({ type: 'user', id: 'alice' })).to.equal(subjectKeyOf({ type: 'user', id: 'alice' }));
    expect(principalSubjectKey({ type: 'user', id: '*' })).to.equal('user:%2A');
    expect(subjectKeyOf({ type: 'user', id: '*' })).to.equal('user:*');
  });

  it('without a MembershipStore sets stay one level deep', async () => {
    const m = await model(ROWS);
    expect((await m.evaluate({ principal: alice, permission: 'file:read', resource: f1 }, ctx())).permitWhen.op).to.equal('false');
  });

  it('a set reached through another set grants, cacheable, bounded by the nested membership', async () => {
    const soon = new Date(NOW.getTime() + 60_000);
    const store = new FakeMembershipStore(CLOSURE, { 'team:t2#team.member': soon });
    const m = await model(ROWS, store);
    const vote = await m.evaluate({ principal: alice, permission: 'file:read', resource: f1 }, ctx());
    expect(vote.permitWhen.op).to.equal('true');
    expect(vote.cacheable).to.equal(true);
    expect(vote.validUntil).to.deep.equal(soon);
    expect(store.calls).to.deep.equal([['user:alice', 'user:*']]);
  });

  it('under a ceiling a nested set grants nothing, but its deny still holds', async () => {
    const capped = withCeiling(alice, { roles: ['team.member', 'viewer'] });
    const m = await model(ROWS, new FakeMembershipStore(CLOSURE));
    expect((await m.evaluate({ principal: capped, permission: 'file:read', resource: f1 }, ctx())).permitWhen.op).to.equal('false');
    const d = await model([...ROWS, row('v1', { type: 'user', id: 'alice' }, 'viewer'), row('b1', setOf('team.member', T2), 'blocked', P1)], new FakeMembershipStore(CLOSURE));
    expect((await d.evaluate({ principal: capped, permission: 'file:read', resource: f1 }, ctx())).denyWhen.op).to.equal('true');
  });
});
