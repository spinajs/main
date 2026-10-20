import { DEFAULT_DENY_PRIORITY, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, EvaluationContext, Principal, ResourceRef } from '@spinajs/authz';
import { fakeEvaluationContext, fakeModelInitContext, userPrincipal, withCeiling } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';
import { renderTemplate } from '@spinajs/log-common';

import { MembershipStore, MemoryAssignmentStore, MemoryRoleStore, MemoryRuleStore, RbacModel, RuleStore } from '../../src/index.js';
import type { GrantDef, RoleDef, RuleDef } from '../../src/index.js';

const logLine = (fields: unknown, template?: unknown): string => (typeof fields === 'string' ? fields : renderTemplate(template as string, fields as Record<string, unknown>));

const expect = chai.expect;

const NOW = new Date('2026-10-14T12:00:00.000Z');
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const O1: ResourceRef = { type: 'org', id: 'o1' };
const alice = userPrincipal('alice');
const ALICE = ['user:*', 'user:alice'];

const role = (name: string, grants: readonly (string | GrantDef)[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const ROLES = [role('viewer', ['doc:read']), role('editor', ['doc:read']), role('pm', [{ permission: 'doc:read', grantedAt: ['project'] }]), role('billing', [{ permission: 'doc:read', requiresTag: 'paid' }]), role('member', [{ permission: 'doc:read', relation: 'owner' }]), role('lead', [], { implies: [{ role: 'viewer', at: 'descendants' }] }), role('org.member', [], { subjectSet: true }), { ...role('blocked', ['doc:read']), deny: true }];
const row = (id: string, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}, subject: AssignmentSubject = { type: 'user', id: 'alice' }): Assignment => ({ id, subject, role: roleName, scope, source: 'test', ...extra });

class Closure extends MembershipStore {
  constructor(private readonly sets: Readonly<Record<string, readonly string[]>>) {
    super();
  }
  async setsOf(keys: readonly string[]): Promise<readonly { setKey: string; expiresAt?: Date }[]> {
    return [...new Set(keys.flatMap((k) => this.sets[k] ?? []))].map((setKey) => ({ setKey }));
  }
  async membersOf(): Promise<readonly string[]> {
    return [];
  }
}

function registry() {
  const r = new PermissionRegistryImpl();
  r.register([{ name: 'doc:read', types: ['doc', 'project', 'org'], list: true }], 'test');
  r.freeze();
  return r;
}

const ctx = (): EvaluationContext => fakeEvaluationContext({ now: NOW });

class EmptyDbRules extends RuleStore {
  readonly name = 'EmptyDbRules';
  async forPath(): Promise<readonly RuleDef[]> {
    return [];
  }
  async version(): Promise<string> {
    return '1';
  }
}

async function plan(rows: readonly Assignment[], opts: { principal?: Principal; config?: Record<string, unknown>; membership?: MembershipStore; rules?: RuleStore } = {}) {
  const reg = registry();
  const m = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(rows), ...(opts.membership ? { membership: opts.membership } : {}), ...(opts.rules ? { rules: opts.rules } : {}), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: reg, config: opts.config ?? {} }));
  m.grantIndex();
  return m.listPlan({ principal: opts.principal ?? alice, permission: reg.require('doc:read'), type: 'doc', env: { now: NOW } }, ctx());
}

const assignmentTerm = (roles: readonly object[], over: Record<string, unknown> = {}) => ({ op: 'rbac.assignment', args: { subjects: ALICE, roles, global: false, ...over } });

describe('authz-rbac listPlan (design §6.2)', () => {
  it('abstains when nothing could grant it', async () => {
    expect(await plan([])).to.deep.equal({ kind: 'abstain' });
  });

  it('a $global grant lists every row, bounded by its expiry', async () => {
    expect(await plan([row('v', 'viewer')])).to.deep.equal({ kind: 'all' });
    const soon = new Date(NOW.getTime() + 60_000);
    expect(await plan([row('v', 'viewer', GLOBAL, { expiresAt: soon })])).to.deep.equal({ kind: 'all', validUntil: soon });
  });

  it('a scoped grant becomes an rbac.assignment term of the roles held', async () => {
    expect(await plan([row('v', 'viewer', P1), row('e', 'editor', P2)])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'editor' }, { role: 'viewer' }])], deny: [] });
  });

  it('carries grantedAt, requiresTag and implies at descendants', async () => {
    expect(await plan([row('p', 'pm', P1)])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'pm', scopeTypes: ['project'] }])], deny: [] });
    expect(await plan([row('b', 'billing', P1, { tags: ['paid'] })])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'billing', tag: 'paid' }])], deny: [] });
    expect(await plan([row('l', 'lead', O1)])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'lead', descendantsOnly: true }])], deny: [] });
  });

  it('a $global deny is deny-all; a scoped deny rides on all', async () => {
    expect(await plan([row('v', 'viewer'), row('b', 'blocked')])).to.deep.equal({ kind: 'deny-all', reason: { code: 'role_denied', role: 'blocked', priority: DEFAULT_DENY_PRIORITY.role_denied } });
    expect(await plan([row('v', 'viewer'), row('b', 'blocked', P2)])).to.deep.equal({ kind: 'all', deny: [assignmentTerm([{ role: 'blocked' }], { global: true })] });
  });

  it('owner from a $global role is a relation.owner term; from a scoped one a role entry with relation', async () => {
    expect(await plan([row('m', 'member')])).to.deep.equal({ kind: 'terms', permit: [{ op: 'relation.owner', args: { principals: [{ type: 'user', id: 'alice' }] } }], deny: [] });
    expect(await plan([row('m', 'member', P1)])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'member', relation: 'owner' }])], deny: [] });
    expect(await plan([row('m', 'member', P1), row('v', 'viewer', P2)])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'member', relation: 'owner' }, { role: 'viewer' }])], deny: [] });
  });

  it('a DB rule store without a matching rule does not block the list', async () => {
    const stored = new MemoryRuleStore({ rules: [{ id: 'other', kind: 'cap', scope: GLOBAL, resourceTypes: ['project'], stripTags: true, source: 'db' }] });
    expect(await plan([row('v', 'viewer', P1)], { rules: stored })).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'viewer' }])], deny: [] });
  });

  it('a stored rule that can match fails the list closed and is logged once', async () => {
    const warned: string[] = [];
    const reg = registry();
    const stored = new MemoryRuleStore({ rules: [{ id: 'old-cap', kind: 'cap', scope: { type: 'project', id: 'p1' }, stripTags: true, source: 'db' }] });
    const m = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore([row('v', 'viewer', P1)]), rules: stored, log: { warn: (fields: unknown, template?: unknown) => void warned.push(logLine(fields, template)) } });
    await m.init(fakeModelInitContext({ model: 'rbac', permissions: reg }));
    m.grantIndex();
    for (let i = 0; i < 2; i++) {
      let caught: unknown;
      try {
        await m.listPlan({ principal: alice, permission: reg.require('doc:read'), type: 'doc', env: { now: NOW } }, ctx());
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).to.contain('rule \'old-cap\' (cap, source: db) can apply to doc:read on "doc"');
    }
    expect(warned.filter((msg) => msg.includes('rule old-cap '))).to.have.length(1);
    const expired = new MemoryRuleStore({ rules: [{ id: 'gone', kind: 'cap', scope: GLOBAL, stripTags: true, expiresAt: new Date(NOW.getTime() - 1), source: 'db' }] });
    expect((await plan([row('v', 'viewer')], { rules: expired })).kind).to.equal('all');
  });

  it('a rule store that cannot list its rules fails every list closed', async () => {
    let caught: unknown;
    try {
      await plan([row('v', 'viewer', P1)], { rules: new EmptyDbRules() });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).to.contain("rule store 'EmptyDbRules' cannot list its rules");
  });

  it('a ceiling keeps its roles only, never drops a deny', async () => {
    const capped = withCeiling(alice, { roles: ['viewer'] });
    expect(await plan([row('v', 'viewer', P1), row('e', 'editor', P2), row('b', 'blocked', O1)], { principal: capped })).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'viewer' }])], deny: [assignmentTerm([{ role: 'blocked' }], { global: true })] });
  });

  it('sets are subjects of the term, nested ones too', async () => {
    const rows = [row('m', 'org.member', O1), row('s', 'viewer', P1, {}, { set: { role: 'org.member', scope: O1 } })];
    expect(await plan(rows)).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'viewer' }], { subjects: ['org:o1#org.member', ...ALICE] })], deny: [] });
    const nested = [row('n', 'viewer', P1, {}, { set: { role: 'org.member', scope: { type: 'org', id: 'o2' } } })];
    expect(await plan(nested, { membership: new Closure({ 'user:alice': ['org:o2#org.member'] }) })).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'viewer' }], { subjects: ['org:o2#org.member', ...ALICE] })], deny: [] });
  });

  it('many sets stay explicit subjects: there is no subject limit any more', async () => {
    const sets = Array.from({ length: 600 }, (_, i): ResourceRef => ({ type: 'org', id: `o${i}` }));
    const rows = [...sets.map((scope, i) => row(`m${i}`, 'org.member', scope)), ...sets.map((scope, i) => row(`s${i}`, 'viewer', P1, {}, { set: { role: 'org.member', scope } }))];
    const result = await plan(rows, { config: { maxPlanSubjects: 2 } });
    expect(result.kind).to.equal('terms');
    const args = (result as unknown as { permit: readonly { args: Record<string, unknown> }[] }).permit[0].args;
    expect(args.subjects).to.have.length(602);
    expect(args).to.not.have.property('membership');
  });

  it('warns once that authz.rbac.maxPlanSubjects is no longer read', async () => {
    const warnings: string[] = [];
    const m = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore([]), log: { warn: (_fields: unknown, template: string) => void warnings.push(template) } as never });
    const init = (config: Record<string, unknown>) => m.init(fakeModelInitContext({ model: 'rbac', permissions: registry(), config }));
    await init({});
    expect(warnings).to.deep.equal([]);
    await init({ maxPlanSubjects: 2 });
    await init({ maxPlanSubjects: 2 });
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.contain('authz.rbac.maxPlanSubjects');
  });
});
