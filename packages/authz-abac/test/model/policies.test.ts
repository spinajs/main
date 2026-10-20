import * as chai from 'chai';
import 'mocha';
import { AuthzConfigError, DefaultConditionCompiler, FALSE, GLOBAL, PermissionRegistryImpl, TRUE, UnknownPermission } from '@spinajs/authz';
import type { Condition, Policy, Principal } from '@spinajs/authz';
import { agentPrincipal, servicePrincipal, userPrincipal } from '@spinajs/authz-testing';

import { DEFAULT_POLICY_PRIORITY, PolicyIndex, loadPolicy, scopeFilter, targets } from '../../src/index.js';

const expect = chai.expect;

const parser = new DefaultConditionCompiler();
const parse = (c: Condition, where: string) => parser.parse(c, where);
const load = (raw: unknown, order = 0) => loadPolicy(raw, order, { source: 'test' }, parse);
const fails = (raw: unknown, pattern: RegExp) => expect(() => load(raw)).to.throw(AuthzConfigError, pattern);

const registry = (): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(
    [
      { name: 'file:read', types: ['file', 'folder'] },
      { name: 'file:write', types: ['file', 'folder'] },
      { name: 'note:read', types: ['note'] },
    ],
    'test',
  );
  r.freeze();
  return r;
};

const alice = userPrincipal('alice');
const bot = servicePrincipal('bot', { companions: [alice] });
const agent = agentPrincipal('ag1', alice);
const NOW = new Date('2026-10-01T12:00:00.000Z');

describe('authz-abac: policies', () => {
  describe('loadPolicy', () => {
    it('returns a frozen checked copy, with defaults', () => {
      const p = load({ id: 'p1', effect: 'deny', permissions: ['file:*'], resourceTypes: ['file'], principalTypes: ['user'], actorTypes: ['agent'], scope: { type: 'org', id: 'o1' }, when: { attr: 'resource.status', eq: 'x' }, fields: { hide: ['email'] }, reason: 'no', priority: 100, expiresAt: '2026-10-02T00:00:00.000Z' }, 3);
      expect(Object.isFrozen(p)).to.equal(true);
      expect(Object.isFrozen(p.policy)).to.equal(true);
      expect(p.order).to.equal(3);
      expect(p.where).to.equal('abac policy "p1"');
      expect(p.policy.source).to.equal('test');
      expect(p.expiresAt?.toISOString()).to.equal('2026-10-02T00:00:00.000Z');
      expect(p.policy.expiresAt).to.be.instanceOf(Date);
      expect(p.priority).to.equal(100);
      expect(p.when?.kind).to.equal('cmp');
      expect([...p.principalTypes!]).to.deep.equal(['user']);
      expect(load({ id: 'p2', effect: 'permit', permissions: ['file:read'] }).priority).to.equal(DEFAULT_POLICY_PRIORITY);
      expect(load({ id: 'p3', effect: 'permit', permissions: ['file:read'], source: 'db' }).policy.source).to.equal('db');
      expect(load({ id: 'p4', effect: 'permit', permissions: ['file:read'], expiresAt: null }).expiresAt).to.equal(undefined);
    });

    it('refuses malformed policies, naming them', () => {
      fails(null, /abac policy #0: is not an object/);
      fails({ effect: 'permit', permissions: ['file:read'] }, /abac policy #0: needs a non-empty string id/);
      fails({ id: 'p1', effect: 'allow', permissions: ['file:read'] }, /abac policy "p1": effect must be 'permit' or 'deny'/);
      fails({ id: 'p1', effect: 'permit', permissions: [] }, /permissions must be a non-empty list/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file'] }, /"file" is not a permission or a permission glob/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], target: 'x' }, /unknown key "target"/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], resourceTypes: [] }, /resourceTypes must be a non-empty list/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], actorTypes: [''] }, /actorTypes must be/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], scope: 'org:o1' }, /scope must be a resource ref/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], fields: { show: ['a'] } }, /fields takes read, write and hide/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], fields: { read: 'a' } }, /fields.read must be a list of field globs/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], fields: { read: ['a b'] } }, /fields.read must be a list of field globs/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], fields: { hide: ['a'] } }, /fields.hide belongs on a deny policy/);
      fails({ id: 'p1', effect: 'deny', permissions: ['file:read'], fields: { read: ['a'] } }, /fields.read and fields.write belong on a permit policy/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], priority: 'high' }, /priority must be a 32-bit integer/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], priority: 99.5 }, /priority must be a 32-bit integer/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], priority: 2 ** 31 }, /priority must be a 32-bit integer/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], scope: { type: 'org', id: '' } }, /scope id must not be empty/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], fields: { read: Array.from({ length: 1001 }, (_, i) => `f${i}`) } }, /fields.read: /);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], scope: { type: '$global', id: 'x' } }, /a \$global scope has no id/);
      expect(load({ id: 'p1', effect: 'permit', permissions: ['file:read'], fields: { read: ['*', '!salary', 'a.*'] } }).policy.fields).to.deep.equal({ read: ['*', '!salary', 'a.*'] });
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], expiresAt: 'soon' }, /expiresAt must be a Date/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], reason: '' }, /reason must be a non-empty string/);
    });

    it('checks the condition with the policy named, unknown functions and bad function args included', () => {
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], when: { attr: 'row.a', eq: 1 } }, /^abac policy "p1" when: "row\.a" must start with/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], when: { fn: 'time.betwen' } }, /^abac policy "p1" when: unknown condition function "time\.betwen"/);
      fails({ id: 'p1', effect: 'permit', permissions: ['file:read'], when: { fn: 'ip.in', args: { cidrs: [] } } }, /^abac policy "p1" when: ip\.in cidrs must be a non-empty list/);
    });
  });

  describe('PolicyIndex', () => {
    const p = (id: string, extra: Partial<Policy> = {}) => ({ id, effect: 'permit', permissions: ['file:read'], ...extra });

    it('indexes policies by the permissions their globs name, in load order', () => {
      const index = new PolicyIndex([load(p('a', { permissions: ['file:*'] }), 0), load(p('b'), 1), load(p('c', { permissions: ['*'] }), 2)], registry());
      expect(index.candidates('file:read', 'file').map((x) => x.policy.id)).to.deep.equal(['a', 'b', 'c']);
      expect(index.candidates('file:write', 'file').map((x) => x.policy.id)).to.deep.equal(['a', 'c']);
      expect(index.candidates('note:read', 'note').map((x) => x.policy.id)).to.deep.equal(['c']);
      expect([...index.permissions()].sort()).to.deep.equal(['file:read', 'file:write', 'note:read']);
    });

    it('filters candidates by resource type', () => {
      const index = new PolicyIndex([load(p('files', { resourceTypes: ['file'] }))], registry());
      expect(index.candidates('file:read', 'file')).to.have.length(1);
      expect(index.candidates('file:read', 'folder')).to.have.length(0);
    });

    it('refuses an unregistered permission name (B02) and a reused id', () => {
      expect(() => new PolicyIndex([load(p('p1', { permissions: ['ghost:read'] }))], registry())).to.throw(UnknownPermission, /abac policy "p1": .*ghost:read/);
      expect(() => new PolicyIndex([load(p('p1')), load(p('p1'), 1)], registry())).to.throw(AuthzConfigError, /abac policy "p1": the id is used twice/);
      // a glob that names nothing is no error
      expect(() => new PolicyIndex([load(p('p1', { permissions: ['ghost:*'] }))], registry())).not.to.throw();
    });
  });

  describe('targets', () => {
    const t = (extra: Partial<Policy>, principal: Principal, actor?: Principal) => targets(load({ id: 'p', effect: 'permit', permissions: ['file:read'], ...extra }), { principal, ...(actor ? { actor } : {}) }, NOW);

    it('match principal types against the principal and its companions', () => {
      expect(t({ principalTypes: ['user'] }, alice)).to.equal(true);
      expect(t({ principalTypes: ['service'] }, alice)).to.equal(false);
      expect(t({ principalTypes: ['user'] }, bot)).to.equal(true);
    });

    it('match actor types against the actor, else the principal acting itself (as conditions read actor.*)', () => {
      expect(t({ actorTypes: ['agent'] }, alice, agent)).to.equal(true);
      expect(t({ actorTypes: ['agent'] }, alice)).to.equal(false);
      expect(t({ actorTypes: ['agent'] }, agent)).to.equal(true);
      expect(t({ actorTypes: ['user'] }, alice, agent)).to.equal(false);
    });

    it('drop a policy at its expiry', () => {
      expect(t({ expiresAt: new Date(NOW.getTime() + 1) }, alice)).to.equal(true);
      expect(t({ expiresAt: NOW }, alice)).to.equal(false);
    });
  });

  describe('scopeFilter', () => {
    const O1 = { type: 'org', id: 'o1' };
    const path = [{ type: 'file', id: 'f1' }, O1, GLOBAL];

    it('is TRUE without a scope or at GLOBAL', () => {
      expect(scopeFilter(undefined, undefined)).to.equal(TRUE);
      expect(scopeFilter(GLOBAL, path)).to.equal(TRUE);
    });

    it('decides on the path of a request with an id', () => {
      expect(scopeFilter(O1, path)).to.equal(TRUE);
      expect(scopeFilter({ type: 'org', id: 'o2' }, path)).to.equal(FALSE);
      expect(scopeFilter({ type: 'org' }, path)).to.equal(TRUE);
    });

    it('is `under` the scope on a type-level request', () => {
      expect(scopeFilter(O1, undefined)).to.deep.equal({ op: 'under', scopes: [O1] });
    });
  });
});
