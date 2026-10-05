import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzAdminFailure, ConditionCompiler, ConditionFunction, SYSTEM, TRUE } from '@spinajs/authz';
import type { AdminCallContext, AuthzCommand, Condition, EvaluationContext, PrincipalRef, ResourceFilter } from '@spinajs/authz';

import { AdminAssignmentStore, AdminRuleStore, AssignmentStore, MemoryAdminAssignmentStore, MemoryRoleStore, MemoryRuleStore, RbacModel, RbacRuleHandler, RuleStore } from '../../src/index.js';
import type { RuleDef } from '../../src/index.js';
import { G, HOUR, LADDERS, O1, P1, P2, ROLES, START, TestBackend, failure, installHost, instance, ok, rbacDomain, rejection, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const DAVE: PrincipalRef = { type: 'user', id: 'dave' };

type Rule = Omit<RuleDef, 'source'>;
const threshold = (r: Partial<Rule> = {}): Rule => ({ id: 'r1', kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor', ...r });
const put = (r: Rule): AuthzCommand => ({ kind: 'rule.put', rule: r });
// The model does not compile a cap with maxRole and no ladder (nor does the config schema accept it).
const LADDERLESS_CAPS: Rule[] = [
  { id: 'c', kind: 'cap', scope: P1, maxRole: 'editor' },
  { id: 'c', kind: 'cap', scope: P1, maxRole: null },
  { id: 'c', kind: 'cap', scope: P1, maxRole: { ref: 'scope.project.cap' } },
];
type Refusal = [string, Rule, { code: string; field: string }];
// Shapes the model's compileRule refuses: once stored, every check on the rule's path fails.
const UNCOMPILABLE: Refusal[] = [
  ...LADDERLESS_CAPS.map((cap): Refusal => [`a cap with maxRole ${JSON.stringify(cap.maxRole)} and no ladder`, cap, { code: 'rule_not_compilable', field: 'rule.ladder' }]),
  ['a threshold minRole on no ladder', threshold({ minRole: 'plain' }), { code: 'unknown_role', field: 'rule.minRole' }],
  ['a restrict maxRole on no ladder', { id: 'x', kind: 'restrict', scope: P1, allow: [DAVE], maxRole: 'plain' }, { code: 'unknown_role', field: 'rule.maxRole' }],
  ['a threshold minRole of null', threshold({ minRole: null as never }), { code: 'invalid_command', field: 'rule.minRole' }],
  ['a maxRole ref of no known root', { id: 'c', kind: 'cap', scope: P1, ladder: 'project', maxRole: { ref: 'resource.owner' } }, { code: 'rule_not_compilable', field: 'rule.maxRole' }],
  ['a minRole ref without a path', threshold({ ladder: 'project', minRole: { ref: 'scope.project' } }), { code: 'rule_not_compilable', field: 'rule.minRole' }],
  ['resource on a cap', { id: 'c', kind: 'cap', scope: P1, stripTags: true, resource: { attr: 'resource.name', eq: 'x' } }, { code: 'rule_not_compilable', field: 'rule.resource' }],
  ['resource on a restrict', { id: 'x', kind: 'restrict', scope: P1, allow: [DAVE], resource: { attr: 'resource.name', eq: 'x' } }, { code: 'rule_not_compilable', field: 'rule.resource' }],
  ['a restrict when reading resource.*', { id: 'x', kind: 'restrict', scope: P1, allow: [DAVE], when: { attr: 'resource.owner', eq: 'x' } }, { code: 'rule_not_compilable', field: 'rule.when' }],
  ['a cap when reading resource.*', { id: 'c', kind: 'cap', scope: P1, stripTags: true, when: { attr: 'resource.owner', null: true } }, { code: 'rule_not_compilable', field: 'rule.when' }],
  ['a subjects.when reading resource.*', threshold({ subjects: { when: { attr: 'resource.owner', null: true } } }), { code: 'rule_not_compilable', field: 'rule.subjects.when' }],
];

/** Compiles anything but { attr: 'principal.bad' }; { attr: 'scope.x' } reads the scope attributes first. */
class FakeCompiler extends ConditionCompiler {
  async compile(c: Condition, _req: unknown, ctx: EvaluationContext): Promise<{ filter: ResourceFilter; cacheable: boolean; needsSubject: boolean }> {
    const attr = (c as { attr?: string }).attr;
    if (attr === 'principal.bad') throw new Error('principal.bad cannot be bound');
    if (attr?.startsWith('scope.')) await ctx.attributes(O1);
    return { filter: TRUE, cacheable: true, needsSubject: false };
  }
}

/** An app compiler with a parse method that checks nothing: it must not switch off the fn name check. */
class ParsingCompiler extends FakeCompiler {
  parse(): object {
    return {};
  }
}

/** Holds only rules without a resource condition (what a DB store refuses outside SQL form). */
class Weekday extends ConditionFunction {
  readonly name = 'time.weekday';
  evaluate(): boolean {
    return true;
  }
}

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
      expect(failure(await d.admin.execute(SYSTEM, [{ kind: 'link.create', scope: P1, role: 'viewer', expiresAt: START }]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'expiresAt' });
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
      expect(failure(await d.admin.execute(alice, [{ kind: 'link.update', id: link.id, expiresAt: new Date(START.getTime() - 1) }]))).to.deep.equal({ at: 0, code: 'invalid_command', field: 'expiresAt' });
    });

    it('link.update with nothing to change changes nothing', async () => {
      const { link } = await d.admin.createLink(alice, { scope: P1, role: 'viewer' });
      const events = d.sink.events.length;
      const [r] = ok(await d.admin.execute(alice, [{ kind: 'link.update', id: link.id }]));
      expect(r.affected).to.equal(0);
      expect(d.sink.events.length).to.equal(events);
      expect(d.bus.published.at(-1)!.tags).to.deep.equal([]);
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

    it('knows a permission whose name prefix is not one of its types (repo:push on branches)', async () => {
      await resetHost();
      d = await rbacDomain('test', { permissions: { 'repo:push': { types: ['project', 'branch'] } } });
      ok(await d.admin.execute(SYSTEM, [put(threshold({ permissions: ['repo:push'] }))]));
    });

    it('accepts a built-in condition function with valid args under the core compiler', async () => {
      ok(await d.admin.execute(SYSTEM, [put(threshold({ when: { fn: 'time.between', args: { from: '09:00', to: '17:00', tz: 'Europe/Warsaw' } } }))]));
      expect((await d.rules.byId('r1'))?.when).to.deep.equal({ fn: 'time.between', args: { from: '09:00', to: '17:00', tz: 'Europe/Warsaw' } });
    });

    it('a parse error names its field once', async () => {
      const [r] = await d.admin.execute(SYSTEM, [put(threshold({ when: { fn: 'no.such.fn' } }))]);
      expect(r.ok).to.equal(false);
      const message = (r as Extract<typeof r, { ok: false }>).error.message;
      expect(message.split('rule.when').length - 1, message).to.equal(1);
    });

    it('a custom compiler with a parse method keeps the function name check', async () => {
      await resetHost();
      d = await rbacDomain('test', { register: (c) => c.register(ParsingCompiler).as(ConditionCompiler) });
      expect(failure(await d.admin.execute(SYSTEM, [put(threshold({ when: { fn: 'no.such.fn' } }))]))).to.deep.equal({ at: 0, code: 'rule_not_compilable', field: 'rule.when' });
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
      // The core registers a ConditionCompiler in every host, so parse faults are what remains to refuse.
      ['a condition naming an unknown function', threshold({ when: { fn: 'no.such.fn' } }), { code: 'rule_not_compilable', field: 'rule.when' }],
      ['a built-in function with an empty range', threshold({ when: { fn: 'time.between', args: { from: '09:00', to: '09:00' } } }), { code: 'rule_not_compilable', field: 'rule.when' }],
      ['an unknown kind', threshold({ kind: 'other' as never }), { code: 'invalid_command', field: 'rule.kind' }],
      ['no id', threshold({ id: '' }), { code: 'invalid_command', field: 'rule.id' }],
      ['no scope', threshold({ scope: undefined as never }), { code: 'invalid_command', field: 'rule.scope' }],
      ['a type-level scope', threshold({ scope: { type: 'project' } }), { code: 'invalid_command', field: 'rule.scope' }],
      ['a threshold without minRole', threshold({ minRole: undefined }), { code: 'invalid_command', field: 'rule.minRole' }],
      ['a threshold naming at without a ladder', threshold({ at: 'project' }), { code: 'invalid_command', field: 'rule.ladder' }],
      ['at on a cap', { id: 'c', kind: 'cap', scope: P1, stripTags: true, at: 'project' }, { code: 'invalid_command', field: 'rule.at' }],
      ['at on a restrict', { id: 'x', kind: 'restrict', scope: P1, allow: [DAVE], at: 'project' }, { code: 'invalid_command', field: 'rule.at' }],
      ...UNCOMPILABLE,
      ['a cap that neither clamps nor strips', { id: 'c', kind: 'cap', scope: P1, ladder: 'project' }, { code: 'invalid_command', field: 'rule.maxRole' }],
      ['a condition with an unknown operator', threshold({ when: { attr: 'scope.org.policies.x', equals: false } }), { code: 'rule_not_compilable', field: 'rule.when' }],
    ];
    for (const [what, rule, expected] of refusals) {
      it(`rule.put refuses ${what}`, async () => {
        expect(failure(await d.admin.execute(SYSTEM, [put(rule)]))).to.deep.equal({ at: 0, ...expected });
        expect((await d.rules.find({})).total).to.equal(0);
      });
    }

    it('a rule the model cannot compile is refused for an actor that manages rules too', async () => {
      for (const [what, rule, expected] of UNCOMPILABLE) expect(failure(await d.admin.execute(alice, [put(rule)])), what).to.deep.equal({ at: 0, ...expected });
      expect((await d.rules.find({})).total).to.equal(0);
    });

    it('accepts a cap with maxRole and its ladder, a cap that only strips tags and a threshold with a ladder and no at', async () => {
      ok(await d.admin.execute(alice, [...LADDERLESS_CAPS.map((cap, i) => put({ ...cap, id: `c${i}`, ladder: 'project' })), put({ id: 'strip', kind: 'cap', scope: P1, stripTags: true }), put(threshold({ ladder: 'project' }))]));
      expect((await d.rules.find({})).total).to.equal(5);
      expect(await d.rules.byId('r1')).to.deep.equal({ ...threshold({ ladder: 'project' }), source: 'memory' });
    });

    it('a threshold may read resource.* in when and resource and take its minRole from a ref', async () => {
      ok(await d.admin.execute(SYSTEM, [put(threshold({ ladder: 'project', minRole: { ref: 'scope.project.policies.min_role' }, when: { attr: 'resource.owner', null: true }, resource: { attr: 'resource.name', eq: 'x' } }))]));
      expect((await d.rules.find({})).total).to.equal(1);
    });

    it('the model parses conditions itself, so a custom compiler does not let through what that parse refuses', async () => {
      await resetHost();
      d = await rbacDomain('test', { register: (c) => c.register(FakeCompiler).as(ConditionCompiler) });
      for (const [what, rule, expected] of UNCOMPILABLE) if (expected.field.endsWith('when')) expect(failure(await d.admin.execute(SYSTEM, [put(rule)])), what).to.deep.equal({ at: 0, ...expected });
      expect(failure(await d.admin.execute(SYSTEM, [put(threshold({ when: { attr: 'principal.id', eq: { ref: 'resource.owner' } } }))]))).to.deep.equal({ at: 0, code: 'rule_not_compilable', field: 'rule.when' });
      expect((await d.rules.find({})).total).to.equal(0);
    });

    it('a refused rule the model cannot compile leaves the checks on its path working (real RbacModel)', async () => {
      await resetHost();
      const assignments = new MemoryAdminAssignmentStore();
      const rules = new MemoryRuleStore();
      // The model wants every ladder role to name its ladder; the admin fixture leaves the org ones out.
      const roles = ROLES.map((r) => {
        const ladder = r.ladder ?? LADDERS.find((l) => l.roles.includes(r.name))?.name;
        return ladder === undefined ? r : { ...r, ladder };
      });
      const model = new RbacModel({ roles: new MemoryRoleStore(roles, LADDERS), assignments, rules, log: { warn: () => undefined } });
      d = await rbacDomain('test', {
        model,
        without: ['assignments', 'rules'],
        register: (c) => {
          c.register(instance(assignments)).as(AssignmentStore);
          c.register(instance(assignments)).as(AdminAssignmentStore);
          c.register(instance(rules)).as(RuleStore);
          c.register(instance(rules)).as(AdminRuleStore);
        },
      });
      const dave = userPrincipal('dave');
      ok(await d.admin.execute(SYSTEM, [{ kind: 'assignment.grant', subject: DAVE, role: 'viewer', scope: P1 }]));
      expect(await d.service.can(dave, 'file:read', P1)).to.equal(true);
      for (const [what, rule, expected] of UNCOMPILABLE) expect(failure(await d.admin.execute(SYSTEM, [put(rule)])), what).to.deep.equal({ at: 0, ...expected });
      expect((await rules.find({})).total).to.equal(0);
      expect(await d.service.can(dave, 'file:read', P1)).to.equal(true);
    });

    it('conditions compile through the domain ConditionCompiler; a probe read is no refusal', async () => {
      await resetHost();
      d = await rbacDomain('test', { register: (c) => c.register(FakeCompiler).as(ConditionCompiler) });
      ok(await d.admin.execute(SYSTEM, [put(threshold({ when: { attr: 'scope.org.policies.x', eq: false }, resource: { attr: 'resource.name', wildcard: 'release/*' } }))]));
      ok(await d.admin.execute(SYSTEM, [put({ id: 'c', kind: 'cap', scope: P1, stripTags: true, subjects: { when: { attr: 'principal.id', eq: 'x' } } })]));
      expect(failure(await d.admin.execute(SYSTEM, [put(threshold({ id: 'r2', when: { attr: 'principal.bad', eq: 1 } }))]))).to.deep.equal({ at: 0, code: 'rule_not_compilable', field: 'rule.when' });
      expect(failure(await d.admin.execute(SYSTEM, [put({ id: 'c2', kind: 'cap', scope: P1, stripTags: true, subjects: { when: { attr: 'principal.bad', eq: 1 } } })]))).to.deep.equal({ at: 0, code: 'rule_not_compilable', field: 'rule.subjects.when' });
    });

    it('checks the condition grammar before the probe, where a scope read would hide the fault', async () => {
      await resetHost();
      d = await rbacDomain('test', { register: (c) => c.register(FakeCompiler).as(ConditionCompiler) });
      const refused = async (when: unknown, field: string) => expect(failure(await d.admin.execute(SYSTEM, [put(threshold({ when: when as Condition }))]))).to.deep.equal({ at: 0, code: 'rule_not_compilable', field });
      await refused({ attr: 'scope.org.policies.x', equals: false }, 'rule.when');
      await refused({ attr: 'scope.org.policies.x', eq: false, ne: true }, 'rule.when');
      await refused(
        {
          any: [
            { attr: 'scope.org.policies.x', eq: false },
            { attr: 'scope.org.policies.y', bogus: 1 },
          ],
        },
        'rule.when.any.1',
      );
      await refused({ all: [{ not: { attr: 'scope.org', eq: 1 } }] }, 'rule.when.all.0.not');
      await refused({ attr: 'session.id', eq: 1 }, 'rule.when');
      await refused({ attr: 'resource.name', wildcard: 3 }, 'rule.when');
      await refused({ attr: 'principal.id', in: 'alice' }, 'rule.when');
      await refused({ any: [] }, 'rule.when');
      await refused({ fn: 'time.weekday' }, 'rule.when');
      ok(
        await d.admin.execute(SYSTEM, [
          put(
            threshold({
              when: {
                any: [
                  { attr: 'scope.org.policies.x', eq: false },
                  { attr: 'principal.attributes.org_only', eq: { ref: 'env.flag' } },
                  { attr: 'principal.id', in: ['a', 'b'] },
                  { attr: 'resource.owner', null: true },
                ],
              },
            }),
          ),
        ]),
      );
    });

    it('a fn condition must name a registered ConditionFunction', async () => {
      await resetHost();
      d = await rbacDomain('test', {
        register: (c) => {
          c.register(FakeCompiler).as(ConditionCompiler);
          c.register(Weekday).as(ConditionFunction);
        },
      });
      ok(await d.admin.execute(SYSTEM, [put(threshold({ when: { fn: 'time.weekday', args: { days: [1] } } }))]));
      expect(failure(await d.admin.execute(SYSTEM, [put(threshold({ id: 'r2', when: { fn: 'time.ghost' } }))]))).to.deep.equal({ at: 0, code: 'rule_not_compilable', field: 'rule.when' });
    });

    it('refuses conditions nested deeper than 32 levels, cycles included, as a failed command', async () => {
      await resetHost();
      d = await rbacDomain('test', { register: (c) => c.register(FakeCompiler).as(ConditionCompiler) });
      const nested = (depth: number): Condition => {
        let c: Condition = { attr: 'principal.id', eq: 'x' };
        for (let i = 1; i < depth; i++) c = i % 2 ? { not: c } : { all: [c] };
        return c;
      };
      const cycle: Record<string, unknown> = {};
      cycle.not = cycle;
      for (const when of [nested(40), cycle as unknown as Condition]) {
        const f = failure(await d.admin.execute(SYSTEM, [put(threshold({ when }))]));
        expect(f.code).to.equal('rule_not_compilable');
        expect(f.field).to.match(/^rule\.when(\.(not|all\.0))+$/);
      }
      ok(await d.admin.execute(SYSTEM, [put(threshold({ when: nested(32) }))]));
      expect(failure(await d.admin.execute(SYSTEM, [put(threshold({ when: nested(33) }))])).code).to.equal('rule_not_compilable');
    });

    it('stores only RuleDef keys', async () => {
      ok(await d.admin.execute(alice, [put({ ...threshold(), extra: 'x', source: 'forged' } as unknown as Rule)]));
      expect(await d.rules.byId('r1')).to.deep.equal({ ...threshold(), source: 'memory' });
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

    it('rule.delete checks the scope again inside the transaction: a rule moved meanwhile is refused', async () => {
      await d.admin.putRule(alice, threshold());
      const h = new RbacRuleHandler();
      const cmd: AuthzCommand = { kind: 'rule.delete', id: 'r1' };
      const ctx: AdminCallContext = { domain: 'test', now: START, authz: d.service, actor: bob, container: d.container, dryRun: false };
      expect(await h.permission(cmd, ctx)).to.deep.equal({ permission: 'authz:rules.manage', resource: P1 });
      // Another admin moves r1 to p2, which bob does not manage, between permission() and apply().
      ok(await d.admin.execute(alice, [{ kind: 'rule.delete', id: 'r1' }]));
      ok(await d.admin.execute(alice, [put(threshold({ scope: P2 }))]));
      const backend = (await d.container.resolve(TestBackend)) as TestBackend;
      const e = await rejection(backend.transaction('test', (tx) => h.apply(cmd, ctx, tx)));
      expect(e).to.be.instanceOf(AuthzAdminFailure);
      expect((e as AuthzAdminFailure).code).to.equal('forbidden');
      expect((await d.rules.byId('r1'))?.scope).to.deep.equal(P2);
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
      await d.admin.assign(alice, { subject: DAVE, role: 'editor', scope: P1, expiresAt: new Date(START.getTime() + 1) });
      await d.admin.assign(alice, { subject: DAVE, role: 'viewer', scope: P2 });
      d.clock.advance(HOUR);
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
