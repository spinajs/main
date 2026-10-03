import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzAdminFailure, ConditionCompiler, SYSTEM, TRUE } from '@spinajs/authz';
import type { AuthzCommand, Condition, EvaluationContext, PrincipalRef, ResourceFilter } from '@spinajs/authz';

import { AdminRuleStore, MemoryRuleStore, RuleStore } from '../../src/index.js';
import type { RuleDef } from '../../src/index.js';
import { G, HOUR, O1, P1, P2, START, failure, installHost, instance, ok, rbacDomain, rejection, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const DAVE: PrincipalRef = { type: 'user', id: 'dave' };

type Rule = Omit<RuleDef, 'source'>;
const threshold = (r: Partial<Rule> = {}): Rule => ({ id: 'r1', kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor', ...r });
const put = (r: Rule): AuthzCommand => ({ kind: 'rule.put', rule: r });

/** Compiles anything but { attr: 'bad' }; { attr: 'scope.x' } reads the scope attributes first. */
class FakeCompiler extends ConditionCompiler {
  async compile(c: Condition, _req: unknown, ctx: EvaluationContext): Promise<{ filter: ResourceFilter; cacheable: boolean; needsSubject: boolean }> {
    const attr = (c as { attr?: string }).attr;
    if (attr === 'bad') throw new Error('unknown operator bogus');
    if (attr?.startsWith('scope.')) await ctx.attributes(O1);
    return { filter: TRUE, cacheable: true, needsSubject: false };
  }
}

/** Holds only rules without a resource condition (what a DB store refuses outside SQL form). */
class PickyRuleStore extends MemoryRuleStore {
  assertStorable(rule: Rule): void {
    if (rule.resource !== undefined) throw new AuthzAdminFailure('rule_not_compilable', 'not in SQL form', 'rule.resource');
  }
}

describe('RBAC link, rule, reader and forget commands', function () {
  this.timeout(20000);
  let d: RbacDomain;

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    d = await rbacDomain();
  });

  describe('links', () => {
    it('link.create stores the link and its assignment; the token is only in the result', async () => {
      const [r] = ok(await d.admin.execute(alice, [{ kind: 'link.create', scope: P1, role: 'viewer', tags: ['code'], attributes: { org_only: true } }]));
      expect(r.token).to.match(/^[A-Za-z0-9_-]{43}$/);
      const token = r.token!;
      const link = await d.links.byToken(token);
      expect(link).to.deep.equal({ id: r.id, scope: P1, expiresAt: null, attributes: { org_only: true }, createdBy: { type: 'user', id: 'alice' } });
      const [grant] = await d.assignments.forSubjects([{ type: 'link', id: r.id! }], START);
      expect(grant).to.deep.include({ role: 'viewer', scope: P1, tags: ['code'] });
      expect([...d.bus.published[0].tags].sort()).to.deep.equal([`link:${r.id}`, `subject:link:${r.id}`]);
      expect(d.sink.events.map((e) => [e.type, e.data])).to.deep.equal([['LinkCreated', { id: r.id, scope: P1, role: 'viewer', expiresAt: null }]]);
      const elsewhere = JSON.stringify([d.sink.events, d.audit.entries, d.bus.published, await d.links.find({}), await d.admin.list(alice, { kind: 'links' })]);
      expect(elsewhere).to.not.include(token);
    });

    it('createLink returns the LinkDef and the token', async () => {
      const at = new Date(START.getTime() + HOUR);
      const { link, token } = await d.admin.createLink(alice, { scope: P1, role: 'viewer', expiresAt: at });
      expect(link.expiresAt?.getTime()).to.equal(at.getTime());
      expect((await d.links.byToken(token))?.id).to.equal(link.id);
    });

    it('link.create refuses unknown, unassignable and misplaced roles and a scope that is no node', async () => {
      const create = (role: string, scope = P1): AuthzCommand => ({ kind: 'link.create', scope, role });
      expect(failure(await d.admin.execute(SYSTEM, [create('ghost')]))).to.deep.equal({ at: 0, code: 'unknown_role', field: 'role' });
      expect(failure(await d.admin.execute(SYSTEM, [create('package')]))).to.deep.equal({ at: 0, code: 'not_assignable', field: 'role' });
      expect(failure(await d.admin.execute(SYSTEM, [create('org.admin')]))).to.deep.equal({ at: 0, code: 'wrong_scope_type', field: 'role' });
      expect(failure(await d.admin.execute(SYSTEM, [create('viewer', G)]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'scope' });
      expect(failure(await d.admin.execute(SYSTEM, [{ kind: 'link.create', scope: P1, role: 'viewer', attributes: [] as never }]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'attributes' });
      expect(failure(await d.admin.execute(bob, [create('viewer', P2)])).code).to.equal('forbidden');
      expect((await d.links.find({})).total).to.equal(0);
    });

    it('link.update changes expiry, attributes, role and tags', async () => {
      const { link } = await d.admin.createLink(alice, { scope: P1, role: 'viewer', tags: ['a'] });
      const at = new Date(START.getTime() + HOUR);
      ok(await d.admin.execute(alice, [{ kind: 'link.update', id: link.id, expiresAt: at, attributes: { org_only: false } }]));
      expect(await d.links.byId(link.id)).to.deep.include({ attributes: { org_only: false } });
      ok(await d.admin.execute(alice, [{ kind: 'link.update', id: link.id, role: 'editor' }]));
      let grants = await d.assignments.forSubjects([{ type: 'link', id: link.id }], START);
      expect(grants.map((a) => [a.role, a.tags])).to.deep.equal([['editor', ['a']]]);
      ok(await d.admin.execute(alice, [{ kind: 'link.update', id: link.id, tags: ['z', 'b'] }]));
      grants = await d.assignments.forSubjects([{ type: 'link', id: link.id }], START);
      expect(grants.map((a) => [a.role, a.tags])).to.deep.equal([['editor', ['b', 'z']]]);
      const e = d.sink.events.at(-1)!;
      expect(e.type).to.equal('LinkUpdated');
      expect(e.data).to.deep.include({ id: link.id, scope: P1, role: 'editor', tags: ['b', 'z'] });
      expect((e.data.expiresAt as Date).getTime()).to.equal(at.getTime());
      expect([...d.bus.published.at(-1)!.tags].sort()).to.deep.equal([`link:${link.id}`, `subject:link:${link.id}`]);
    });

    it('link.update refuses unknown links, roles at the wrong scope type and actors without the permission at the link scope', async () => {
      const { link } = await d.admin.createLink(alice, { scope: P2, role: 'viewer' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'link.update', id: 'nope', role: 'viewer' }]))).to.deep.equal({ at: 0, code: 'not_found', field: 'id' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'link.update', id: link.id, role: 'org.admin' }]))).to.deep.equal({ at: 0, code: 'wrong_scope_type', field: 'role' });
      expect(failure(await d.admin.execute(bob, [{ kind: 'link.update', id: link.id, expiresAt: null }])).code).to.equal('forbidden');
    });

    it('link.revoke removes the link and its assignment', async () => {
      const { link, token } = await d.admin.createLink(alice, { scope: P1, role: 'viewer' });
      await d.admin.revokeLink(bob, link.id);
      expect(await d.links.byToken(token)).to.equal(null);
      expect(await d.assignments.forSubjects([{ type: 'link', id: link.id }], START)).to.deep.equal([]);
      expect(d.sink.events.at(-1)).to.deep.include({ type: 'LinkRevoked', data: { id: link.id, scope: P1 } });
      expect(((await rejection(d.admin.revokeLink(alice, link.id))) as AuthzAdminFailure).code).to.equal('not_found');
    });
  });

  describe('rules', () => {
    it('rule.put stores the rule, replaces it by id and emits RuleChanged', async () => {
      const [r] = ok(await d.admin.execute(alice, [put(threshold())]));
      expect(r).to.deep.equal({ ok: true, kind: 'rule.put', id: 'r1', affected: 1 });
      expect(await d.rules.byId('r1')).to.deep.equal({ ...threshold(), source: 'memory' });
      await d.admin.putRule(alice, threshold({ minRole: 'maintainer', ladder: 'project', at: 'project' }));
      expect((await d.rules.byId('r1'))?.minRole).to.equal('maintainer');
      expect(d.bus.published.at(-1)!.tags).to.deep.equal(['rule:r1']);
      expect(d.sink.events.at(-1)).to.deep.include({ type: 'RuleChanged', data: { id: 'r1', scope: P1, op: 'put' } });
      expect((await d.rules.forPath([G, O1, P1], START)).map((x) => x.id)).to.deep.equal(['r1']);
    });

    it('accepts the rule shapes of the canvas config', async () => {
      ok(await d.admin.execute(alice, [put({ id: 'restrict:file:f1', kind: 'restrict', scope: { type: 'file', id: 'f1' }, allow: [DAVE, { set: { role: 'group.member', scope: { type: 'group', id: 'g1' } } }] }), put({ id: 'cap', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'editor', assignments: { scopeTypes: ['file'], subjectTypes: ['link'] } }), put({ id: 'cap-ref', kind: 'cap', scope: O1, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_link_role' } }), put({ id: 'drop', kind: 'cap', scope: O1, ladder: 'project', maxRole: null, subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.member' } } }), put({ id: 'glob', kind: 'threshold', scope: P1, permissions: ['*', 'file:*'], ladder: 'org', at: 'org', minRole: 'org.member', reason: { code: 'link_invalid', priority: 300 } })]));
      expect((await d.rules.find({})).total).to.equal(5);
    });

    const refusals: [string, Rule, { code: string; field?: string }][] = [
      ['an unknown ladder', threshold({ ladder: 'ghost', at: 'project' }), { code: 'unknown_ladder', field: 'rule.ladder' }],
      ['an unknown role', threshold({ ladder: 'project', at: 'project', minRole: 'ghost' }), { code: 'unknown_role', field: 'rule.minRole' }],
      ['a role off the rule ladder', threshold({ ladder: 'project', at: 'project', minRole: 'org.member' }), { code: 'unknown_role', field: 'rule.minRole' }],
      ['an unknown cap role', { id: 'c', kind: 'cap', scope: P1, maxRole: 'ghost' }, { code: 'unknown_role', field: 'rule.maxRole' }],
      ['an unknown rank ladder', { id: 'c', kind: 'cap', scope: P1, stripTags: true, subjects: { rank: { ladder: 'ghost', at: 'org' } } }, { code: 'unknown_ladder', field: 'rule.subjects.rank.ladder' }],
      ['a rank role off its ladder', { id: 'c', kind: 'cap', scope: P1, stripTags: true, subjects: { rank: { ladder: 'org', at: 'org', lt: 'viewer' } } }, { code: 'unknown_role', field: 'rule.subjects.rank.lt' }],
      ['an unknown permission', threshold({ permissions: ['file:edit', 'ghost:read'] }), { code: 'unknown_permission', field: 'rule.permissions.1' }],
      ['a malformed glob', threshold({ permissions: ['file:**'] }), { code: 'unknown_permission', field: 'rule.permissions.0' }],
      ['a malformed name', threshold({ permissions: ['nope'] }), { code: 'unknown_permission', field: 'rule.permissions.0' }],
      ['a subject set of a role that is no set', { id: 'x', kind: 'restrict', scope: P1, allow: [{ set: { role: 'plain', scope: O1 } }] }, { code: 'unknown_role', field: 'rule.allow.0.set.role' }],
      ['a condition without a ConditionCompiler', threshold({ when: { attr: 'scope.org.policies.x', eq: false } }), { code: 'rule_not_compilable', field: 'rule.when' }],
      ['a resource condition without a ConditionCompiler', threshold({ resource: { attr: 'resource.name', wildcard: 'release/*' } }), { code: 'rule_not_compilable', field: 'rule.resource' }],
      ['an unknown kind', threshold({ kind: 'other' as never }), { code: 'invalid_command', field: 'rule.kind' }],
      ['no id', threshold({ id: '' }), { code: 'invalid_command', field: 'rule.id' }],
      ['no scope', threshold({ scope: undefined as never }), { code: 'invalid_command', field: 'rule.scope' }],
    ];
    for (const [what, rule, expected] of refusals) {
      it(`rule.put refuses ${what}`, async () => {
        expect(failure(await d.admin.execute(SYSTEM, [put(rule)]))).to.deep.equal({ at: 0, ...expected });
        expect((await d.rules.find({})).total).to.equal(0);
      });
    }

    it('conditions compile through the domain ConditionCompiler; a probe read is no refusal', async () => {
      await resetHost();
      d = await rbacDomain('test', { register: (c) => c.register(FakeCompiler).as(ConditionCompiler) });
      ok(await d.admin.execute(SYSTEM, [put(threshold({ when: { attr: 'scope.org.policies.x', eq: false }, resource: { attr: 'resource.name', wildcard: 'release/*' } }))]));
      ok(await d.admin.execute(SYSTEM, [put({ id: 'c', kind: 'cap', scope: P1, stripTags: true, subjects: { when: { attr: 'principal.id', eq: 'x' } } })]));
      expect(failure(await d.admin.execute(SYSTEM, [put(threshold({ id: 'r2', when: { attr: 'bad' } }))]))).to.deep.equal({ at: 0, code: 'rule_not_compilable', field: 'rule.when' });
      expect(failure(await d.admin.execute(SYSTEM, [put({ id: 'c2', kind: 'cap', scope: P1, subjects: { when: { attr: 'bad' } } })]))).to.deep.equal({ at: 0, code: 'rule_not_compilable', field: 'rule.subjects.when' });
    });

    it('AdminRuleStore.assertStorable has the last word', async () => {
      const picky = new PickyRuleStore();
      await resetHost();
      d = await rbacDomain('test', {
        without: ['rules'],
        register: (c) => {
          c.register(FakeCompiler).as(ConditionCompiler);
          c.register(instance(picky)).as(RuleStore);
          c.register(instance(picky)).as(AdminRuleStore);
        },
      });
      expect(failure(await d.admin.execute(SYSTEM, [put(threshold({ resource: { attr: 'resource.name', glob: 'a*b*' } }))]))).to.deep.equal({ at: 0, code: 'rule_not_compilable', field: 'rule.resource' });
      ok(await d.admin.execute(SYSTEM, [put(threshold())]));
    });

    it('a rule id is not moved to another scope', async () => {
      await d.admin.putRule(alice, threshold());
      expect(failure(await d.admin.execute(alice, [put(threshold({ scope: P2 }))]))).to.deep.equal({ at: 0, code: 'conflict', field: 'rule.id' });
      expect(failure(await d.admin.execute(alice, [put(threshold({ id: 'n', scope: P2 })), put(threshold({ id: 'n' }))]))).to.deep.equal({ at: 1, code: 'conflict', field: 'rule.id' });
    });

    it('the permission is checked at the rule scope; rule.delete loads the rule first', async () => {
      expect(failure(await d.admin.execute(bob, [put(threshold({ scope: P2 }))])).code).to.equal('forbidden');
      await d.admin.putRule(alice, threshold({ scope: P2 }));
      expect(failure(await d.admin.execute(bob, [{ kind: 'rule.delete', id: 'r1' }])).code).to.equal('forbidden');
      expect(failure(await d.admin.execute(alice, [{ kind: 'rule.delete', id: 'nope' }]))).to.deep.equal({ at: 0, code: 'not_found', field: 'id' });
      await d.admin.deleteRule(alice, 'r1');
      expect(await d.rules.byId('r1')).to.equal(null);
      expect(d.sink.events.at(-1)).to.deep.include({ type: 'RuleChanged', data: { id: 'r1', scope: P2, op: 'delete' } });
      expect(d.bus.published.at(-1)!.tags).to.deep.equal(['rule:r1']);
    });
  });

  describe('readers', () => {
    it('lists assignments with filters and pages', async () => {
      for (const id of ['u1', 'u2', 'u3']) await d.admin.assign(alice, { subject: { type: 'user', id }, role: 'viewer', scope: P1 });
      await d.admin.assign(alice, { subject: DAVE, role: 'editor', scope: P1, expiresAt: new Date(START.getTime() - 1) });
      await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P2 });
      const all = await d.admin.list(alice, { kind: 'assignments' });
      expect(all.total).to.equal(4);
      const page = await d.admin.list(alice, { kind: 'assignments', scope: P1, page: { limit: 2, offset: 1 } });
      expect(page.total).to.equal(3);
      expect(page.items.map((a) => (a as { subject: PrincipalRef }).subject.id)).to.deep.equal(['u2', 'u3']);
      expect((await d.admin.list(alice, { kind: 'assignments', subject: DAVE })).total).to.equal(1);
      expect((await d.admin.list(alice, { kind: 'assignments', subject: DAVE, includeExpired: true })).total).to.equal(2);
      expect((await d.admin.list(alice, { kind: 'assignments', role: 'editor', includeExpired: true })).total).to.equal(1);
    });

    it('lists links without tokens and rules by scope', async () => {
      const { token } = await d.admin.createLink(alice, { scope: P1, role: 'viewer' });
      await d.admin.createLink(alice, { scope: P2, role: 'viewer' });
      await d.admin.putRule(alice, threshold());
      await d.admin.putRule(alice, threshold({ id: 'r2', scope: P2 }));
      const links = await d.admin.list(alice, { kind: 'links', scope: P1 });
      expect(links.total).to.equal(1);
      expect(Object.keys(links.items[0] as object).sort()).to.deep.equal(['attributes', 'createdBy', 'expiresAt', 'id', 'scope']);
      expect(JSON.stringify(links)).to.not.include(token);
      const rules = await d.admin.list(alice, { kind: 'rules', scope: P2 });
      expect(rules.items.map((r) => (r as RuleDef).id)).to.deep.equal(['r2']);
      expect((await d.admin.list(alice, { kind: 'rules', page: { limit: 1, offset: 0 } })).items).to.have.length(1);
    });

    it('a malformed filter is invalid_query', async () => {
      const e = (await rejection(d.admin.list(alice, { kind: 'assignments', subject: { type: 'user' } as never }))) as AuthzAdminFailure;
      expect(e.code).to.equal('invalid_query');
    });
  });

  describe('scope.forget', () => {
    it('removes assignments, links with their assignments and rules AT the scope', async () => {
      const at = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1 });
      const viaSet = await d.admin.assign(alice, { subject: { set: { role: 'org.member', scope: O1 } }, role: 'viewer', scope: P2 });
      const p2 = await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P2 });
      const { link } = await d.admin.createLink(alice, { scope: P1, role: 'viewer' });
      const other = await d.admin.createLink(alice, { scope: P2, role: 'viewer' });
      await d.admin.putRule(alice, threshold());
      await d.admin.putRule(alice, threshold({ id: 'r2', scope: P2 }));
      d.sink.batches.length = 0;
      d.bus.published.length = 0;
      const [r] = ok(await d.admin.execute(alice, [{ kind: 'scope.forget', scope: P1 }]));
      expect(r.affected).to.equal(3);
      expect(await d.assignments.byId(at.id)).to.equal(null);
      expect(await d.links.byId(link.id)).to.equal(null);
      expect(await d.assignments.forSubjects([{ type: 'link', id: link.id }], START)).to.deep.equal([]);
      expect(await d.rules.byId('r1')).to.equal(null);
      for (const id of [viaSet.id, p2.id]) expect(await d.assignments.byId(id)).to.not.equal(null);
      expect(await d.links.byId(other.link.id)).to.not.equal(null);
      expect(await d.rules.byId('r2')).to.not.equal(null);
      expect(d.sink.events.map((e) => e.type)).to.deep.equal(['LinkRevoked', 'RoleRevoked', 'RuleChanged', 'ScopeForgotten']);
      expect([...d.bus.published[0].tags].sort()).to.deep.equal([`link:${link.id}`, 'rule:r1', 'scope:project:p1', `subject:link:${link.id}`, 'subject:user:dave']);
    });

    it('skips the kinds of data a domain keeps no store for', async () => {
      await resetHost();
      d = await rbacDomain('test', { without: ['links', 'rules'] });
      await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1 });
      const [r] = ok(await d.admin.execute(alice, [{ kind: 'scope.forget', scope: P1 }]));
      expect(r.affected).to.equal(1);
    });

    it('a failed batch puts the forgotten data back', async () => {
      await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P1 });
      await d.admin.createLink(alice, { scope: P1, role: 'viewer' });
      await d.admin.putRule(alice, threshold());
      const snapshot = async () => JSON.stringify([await d.assignments.find({ at: START, includeExpired: true }), await d.links.find({}), await d.rules.find({})]);
      const before = await snapshot();
      expect(
        failure(
          await d.admin.execute(alice, [
            { kind: 'scope.forget', scope: P1 },
            { kind: 'rule.delete', id: 'r1' },
          ]),
        ).code,
      ).to.equal('not_found');
      expect(await snapshot()).to.equal(before);
    });
  });
});
