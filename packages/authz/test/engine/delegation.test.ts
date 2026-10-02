import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { resolveDelegation, stripPrincipalOps } from '../../src/engine/delegation.js';
import { ceilingOutcome, mergeCeilings } from '../../src/engine/ceiling.js';
import * as authz from '../../src/index.js';
import { AuthzConfigError, FALSE, SYSTEM, TRUE, UNATTENDED, and, not, or } from '../../src/index.js';
import type { Ceiling, Delegation, Principal, ResourceFilter } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-02T12:00:00.000Z');

type Mutable = { -readonly [K in keyof Principal]: Principal[K] };

function principal(type: string, id: string, extra: Partial<Mutable> = {}): Mutable {
  return { type, id, authenticated: true, source: 'token', attributes: { tier: 'gold' }, ...extra };
}

const roles = (p: Principal): readonly string[] | undefined => p.ceiling?.roles;

describe('engine/delegation', () => {
  it('the package exports resolveDelegation, stripPrincipalOps and the Delegation type', () => {
    expect(authz.resolveDelegation).to.equal(resolveDelegation);
    expect(authz.stripPrincipalOps).to.equal(stripPrincipalOps);
    const d: Delegation = authz.resolveDelegation(principal('user', 'u1'), undefined, 2);
    expect(d.denial).to.equal(undefined);
  });

  describe('resolveDelegation', () => {
    it('no delegate: the principal runs as is', () => {
      const p = principal('user', 'u1');
      const d = resolveDelegation(p, undefined, 2);
      expect(d.principal).to.equal(p);
      expect(d.actor).to.equal(undefined);
      expect(d.ceilings).to.deep.equal([]);
      expect(d.intersect).to.equal(undefined);
      expect(d.denial).to.equal(undefined);
      expect(d.chain).to.deep.equal([p]);
      expect(d.chain[0]).to.equal(p);
      expect(d.hopsUsed).to.equal(0);
      expect(Object.isFrozen(d)).to.equal(true);
      expect(Object.isFrozen(d.chain)).to.equal(true);
      expect(Object.isFrozen(d.ceilings)).to.equal(true);
    });

    it('a malformed ceiling on the request principal becomes a deny-all ceiling', () => {
      const p = principal('user', 'u1', { ceiling: { permissions: 'doc:*' } as unknown as Ceiling });
      const d = resolveDelegation(p, undefined, 2);
      expect(d.denial).to.equal(undefined);
      expect(d.ceilings).to.deep.equal([{ permissions: [] }]);
      expect(ceilingOutcome(d.ceilings[0], 'doc:read', { type: 'doc' }, undefined, NOW).denials).to.deep.equal([{ code: 'ceiling', priority: 200 }]);
    });

    it('keeps the request actor and the principal ceiling', () => {
      const p = principal('user', 'u1', { ceiling: { permissions: ['doc:*'] } });
      const actor = principal('service', 'svc');
      const d = resolveDelegation(p, actor, 2);
      expect(d.actor).to.equal(actor);
      expect(d.ceilings).to.deep.equal([{ permissions: ['doc:*'] }]);
    });

    it('a null onBehalfOf counts as absent', () => {
      const p = principal('user', 'u1', { onBehalfOf: null as unknown as Principal, delegation: 'inherit' });
      const d = resolveDelegation(p, undefined, 0);
      expect(d.principal).to.equal(p);
      expect(d.hopsUsed).to.equal(0);
    });

    describe('inherit', () => {
      it('runs the models with a narrowed copy of the delegate and the agent as actor', () => {
        const user = principal('user', 'u1', { ceiling: { roles: ['owner', 'viewer'], permissions: ['doc:*'] } });
        const agent = principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit', ceiling: { roles: ['viewer', 'editor'], reason: 'agents_disabled' } });
        const d = resolveDelegation(agent, undefined, 2);

        expect(d.principal).to.not.equal(user);
        expect(d.principal.type).to.equal('user');
        expect(d.principal.id).to.equal('u1');
        expect(d.principal.attributes).to.equal(user.attributes);
        expect(roles(d.principal)).to.deep.equal(['viewer']);
        expect(d.principal.ceiling?.permissions).to.deep.equal(['doc:*']);
        expect(Object.isFrozen(d.principal)).to.equal(true);
        expect(Object.isFrozen(d.principal.ceiling)).to.equal(true);
        expect(d.actor).to.equal(agent);
        expect(d.intersect).to.equal(undefined);
        expect(d.denial).to.equal(undefined);
        expect(d.chain).to.deep.equal([agent, user]);
        expect(d.chain[1]).to.equal(user);
        expect(d.hopsUsed).to.equal(1);
        expect(d.ceilings).to.deep.equal([
          { roles: ['viewer', 'editor'], reason: 'agents_disabled' },
          { roles: ['owner', 'viewer'], permissions: ['doc:*'] },
        ]);
        expect(Object.isFrozen(user)).to.equal(false);
        expect(user.ceiling?.roles).to.deep.equal(['owner', 'viewer']);
      });

      it('an explicit request actor wins over the agent', () => {
        const user = principal('user', 'u1');
        const agent = principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit' });
        const actor = principal('agent', 'a2');
        expect(resolveDelegation(agent, actor, 2).actor).to.equal(actor);
      });

      it('both ceilings still apply through the engine (agent denial wins over the delegate)', () => {
        const user = principal('user', 'u1', { ceiling: { resources: [{ type: 'org', id: 'o2' }], reason: 'out_of_scope' } });
        const agent = principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit', ceiling: { permissions: [], reason: 'agents_disabled' } });
        const d = resolveDelegation(agent, undefined, 2);
        const ref = { type: 'doc', id: 'd1' };
        const merged = mergeCeilings(d.ceilings.map((c) => ceilingOutcome(c, 'doc:read', ref, [ref, { type: 'org', id: 'o1' }], NOW)));
        expect(merged.denials.map((x) => x.code)).to.deep.equal(['agents_disabled', 'out_of_scope']);
        expect(merged.restrict).to.equal(FALSE);
      });

      it('two inherit hops narrow roles through the whole chain', () => {
        const user = principal('user', 'u1', { ceiling: { roles: ['a', 'b', 'c'] } });
        const mid = principal('agent', 'm1', { onBehalfOf: user, delegation: 'inherit', ceiling: { roles: ['b', 'c', 'd'] } });
        const top = principal('agent', 't1', { onBehalfOf: mid, delegation: 'inherit', ceiling: { roles: ['c', 'b'] } });
        const d = resolveDelegation(top, undefined, 2);
        expect(d.principal.id).to.equal('u1');
        expect(roles(d.principal)).to.deep.equal(['b', 'c']);
        expect(d.actor).to.equal(top);
        expect(d.ceilings.length).to.equal(3);
        expect(d.chain).to.deep.equal([top, mid, user]);
        expect(d.hopsUsed).to.equal(2);
      });

      it('an agent without roles leaves the delegate roles; neither has roles leaves no ceiling', () => {
        const user = principal('user', 'u1', { ceiling: { roles: ['viewer'] } });
        expect(roles(resolveDelegation(principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit' }), undefined, 2).principal)).to.deep.equal(['viewer']);
        const bare = principal('user', 'u2');
        const d = resolveDelegation(principal('agent', 'a1', { onBehalfOf: bare, delegation: 'inherit' }), undefined, 2);
        expect(d.principal.ceiling).to.equal(undefined);
        expect(Object.hasOwn(d.principal, 'ceiling')).to.equal(false);
      });

      it('a delegate without roles takes the agent roles', () => {
        const user = principal('user', 'u1');
        const d = resolveDelegation(principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit', ceiling: { roles: ['viewer'] } }), undefined, 2);
        expect(d.principal.ceiling).to.deep.equal({ roles: ['viewer'] });
      });

      it('a malformed delegate ceiling denies through the ceilings and leaves no roles', () => {
        const user = principal('user', 'u1', { ceiling: { roles: 'admin' } as unknown as Ceiling });
        const d = resolveDelegation(principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit' }), undefined, 2);
        expect(roles(d.principal)).to.deep.equal([]);
        const outcomes = d.ceilings.map((c) => ceilingOutcome(c, 'doc:read', { type: 'doc' }, undefined, NOW));
        expect(mergeCeilings(outcomes).denials.map((x) => x.code)).to.deep.equal(['ceiling']);
      });
    });

    describe('intersect', () => {
      it('runs the models with the principal and asks for the delegate decision', () => {
        const user = principal('user', 'u1', { ceiling: { permissions: ['doc:read'] } });
        const token = principal('service', 'tok', { onBehalfOf: user, ceiling: { permissions: ['doc:*'] } });
        const d = resolveDelegation(token, undefined, 2);
        expect(d.principal).to.equal(token);
        expect(d.actor).to.equal(undefined);
        expect(d.intersect).to.deep.equal(user);
        expect(d.intersect).to.not.equal(user);
        expect(Object.isFrozen(d.intersect)).to.equal(true);
        expect(d.intersectKey).to.equal('user:u1');
        expect(d.ceilings).to.deep.equal([{ permissions: ['doc:*'] }]);
        expect(d.chain).to.deep.equal([token, user]);
        expect(d.hopsUsed).to.equal(1);
        expect(d.denial).to.equal(undefined);
      });

      it('explicit intersect and an unknown mode both intersect', () => {
        const user = principal('user', 'u1');
        expect(resolveDelegation(principal('service', 's', { onBehalfOf: user, delegation: 'intersect' }), undefined, 2).intersect).to.deep.equal(user);
        expect(resolveDelegation(principal('service', 's', { onBehalfOf: user, delegation: 'INHERIT' as 'inherit' }), undefined, 2).intersect).to.deep.equal(user);
      });

      it('inherit then intersect', () => {
        const user = principal('user', 'u1');
        const mid = principal('agent', 'm1', { onBehalfOf: user, ceiling: { roles: ['x', 'y'] } });
        const top = principal('agent', 't1', { onBehalfOf: mid, delegation: 'inherit', ceiling: { roles: ['y'] } });
        const d = resolveDelegation(top, undefined, 2);
        expect(d.principal.id).to.equal('m1');
        expect(roles(d.principal)).to.deep.equal(['y']);
        expect(d.actor).to.equal(top);
        expect(d.intersect).to.deep.equal(user);
        expect(d.chain).to.deep.equal([top, mid, user]);
        expect(d.hopsUsed).to.equal(2);
      });

      it('counts the hops beyond the intersected delegate against the same budget', () => {
        const v = principal('user', 'v1');
        const user = principal('user', 'u1', { onBehalfOf: v, delegation: 'inherit' });
        const token = principal('service', 'tok', { onBehalfOf: user });
        expect(() => resolveDelegation(token, undefined, 1)).to.throw(AuthzConfigError);
        const d = resolveDelegation(token, undefined, 2);
        expect(d.intersect).to.deep.equal(user);
        expect(d.hopsUsed).to.equal(1);
        expect(d.chain).to.deep.equal([token, user, v]);
      });

      it('a forbidden principal beyond the intersected delegate denies', () => {
        const user = principal('user', 'u1', { onBehalfOf: SYSTEM });
        const token = principal('service', 'tok', { onBehalfOf: user });
        const d = resolveDelegation(token, undefined, 2);
        expect(d.denial).to.deep.equal({ code: 'delegate', priority: 200, delegate: 'system:system' });
      });
    });

    describe('depth', () => {
      const chainOf = (n: number, delegation?: 'inherit' | 'intersect'): Principal => {
        let p: Mutable = principal('user', 'u0');
        for (let i = 1; i <= n; i++) p = principal('agent', `a${i}`, { onBehalfOf: p, delegation });
        return p;
      };

      for (const mode of ['inherit', 'intersect', undefined] as const) {
        it(`exactly max hops is fine, max + 1 throws (${mode ?? 'default'})`, () => {
          expect(resolveDelegation(chainOf(2, mode), undefined, 2).denial).to.equal(undefined);
          expect(() => resolveDelegation(chainOf(3, mode), undefined, 2)).to.throw(AuthzConfigError);
          expect(() => resolveDelegation(chainOf(1, mode), undefined, 0)).to.throw(AuthzConfigError);
          expect(resolveDelegation(chainOf(0, mode), undefined, 0).hopsUsed).to.equal(0);
        });
      }

      it('a self cycle throws whatever the max', () => {
        const p = principal('agent', 'a1', { delegation: 'inherit' });
        p.onBehalfOf = p;
        expect(() => resolveDelegation(p, undefined, 1000)).to.throw(AuthzConfigError);
      });

      it('a two-node cycle throws', () => {
        const a = principal('agent', 'a1');
        const b = principal('agent', 'b1', { onBehalfOf: a });
        a.onBehalfOf = b;
        expect(() => resolveDelegation(a, undefined, 1000)).to.throw(AuthzConfigError);
        a.delegation = 'inherit';
        b.delegation = 'inherit';
        expect(() => resolveDelegation(a, undefined, 1000)).to.throw(AuthzConfigError);
      });

      it('depth is checked before the delegate is judged', () => {
        expect(() => resolveDelegation(principal('agent', 'a', { onBehalfOf: SYSTEM }), undefined, 0)).to.throw(AuthzConfigError);
      });

      it('an invalid max throws', () => {
        for (const max of [-1, 1.5, NaN, Infinity, '2' as unknown as number]) {
          expect(() => resolveDelegation(principal('user', 'u'), undefined, max), String(max)).to.throw(AuthzConfigError);
        }
      });
    });

    describe('forbidden delegates', () => {
      const forged = (type: string) => Object.freeze({ type, id: type, authenticated: true, source: 'runAs', attributes: {} });
      const cases: [string, unknown, string | undefined][] = [
        ['SYSTEM', SYSTEM, 'system:system'],
        ['UNATTENDED', UNATTENDED, 'unattended:unattended'],
        ['a forged system', forged('system'), 'system:system'],
        ['a forged unattended', forged('unattended'), 'unattended:unattended'],
        ['a string', 'user:u1', undefined],
        ['a number', 7, undefined],
        ['an object without id', { type: 'user' }, undefined],
        ['an object with a numeric id', { type: 'user', id: 1 }, undefined],
        ['an object with an empty type', { type: '', id: 'x' }, undefined],
        [
          'an object whose type getter throws',
          {
            get type(): string {
              throw new Error('x');
            },
            id: 'u',
          },
          undefined,
        ],
      ];

      for (const [name, delegate, key] of cases) {
        for (const mode of ['inherit', 'intersect'] as const) {
          it(`${name} as a delegate (${mode}) denies`, () => {
            const p = principal('agent', 'a1', { onBehalfOf: delegate as Principal, delegation: mode });
            const d = resolveDelegation(p, undefined, 2);
            const expected: Record<string, unknown> = { code: 'delegate', priority: 200 };
            if (key !== undefined) expected.delegate = key;
            expect(d.denial).to.deep.equal(expected);
            expect(Object.isFrozen(d.denial)).to.equal(true);
            expect(d.intersect).to.equal(undefined);
            expect(d.chain).to.deep.equal([p]);
          });
        }
      }

      it('a forbidden delegate after an inherit hop denies', () => {
        const mid = principal('agent', 'm', { onBehalfOf: UNATTENDED, delegation: 'inherit' });
        const d = resolveDelegation(principal('agent', 't', { onBehalfOf: mid, delegation: 'inherit' }), undefined, 2);
        expect(d.denial).to.deep.equal({ code: 'delegate', priority: 200, delegate: 'unattended:unattended' });
      });
    });

    describe('hostile principals', () => {
      it('the narrowed delegate does not share a mutable Date with the applied ceilings', () => {
        const at = new Date('2026-10-02T11:00:00.000Z');
        for (const agentCeiling of [undefined, { roles: ['viewer'] }]) {
          const user = principal('user', 'u1', { ceiling: { roles: ['viewer'], expiresAt: at } });
          const agent = principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit', ceiling: agentCeiling });
          const d = resolveDelegation(agent, undefined, 2);
          d.principal.ceiling!.expiresAt!.setTime(Date.parse('2099-01-01T00:00:00Z'));
          const merged = mergeCeilings(d.ceilings.map((c) => ceilingOutcome(c, 'doc:read', { type: 'doc' }, undefined, NOW)));
          expect(merged.denials.map((x) => x.code)).to.deep.equal(['ceiling']);
          expect(at.getTime()).to.equal(Date.parse('2026-10-02T11:00:00.000Z'));
        }
      });

      it('the intersect delegate and its key come from one read', () => {
        let n = 0;
        const user = {
          ...principal('user', 'u1'),
          get id(): string {
            return n++ === 0 ? 'u1' : 'tok';
          },
        };
        const d = resolveDelegation(principal('service', 'tok', { onBehalfOf: user }), undefined, 2);
        expect(d.intersectKey).to.equal('user:u1');
        expect(d.intersect?.id).to.equal('u1');
        expect(d.intersect?.id).to.equal('u1');
      });

      it('an intersect delegate that cannot be copied denies', () => {
        const user = {
          ...principal('user', 'u1'),
          get attributes(): Record<string, unknown> {
            throw new Error('boom');
          },
        };
        const d = resolveDelegation(principal('service', 'tok', { onBehalfOf: user }), undefined, 2);
        expect(d.denial).to.deep.equal({ code: 'delegate', priority: 200, delegate: 'user:u1' });
        expect(d.intersect).to.equal(undefined);
      });

      it('a throwing onBehalfOf on the request principal denies without a crash', () => {
        const p = {
          ...principal('agent', 'a1'),
          get onBehalfOf(): Principal {
            throw new Error('boom');
          },
        };
        const d = resolveDelegation(p, undefined, 2);
        expect(d.denial).to.deep.equal({ code: 'delegate', priority: 200 });
      });

      it('a throwing ceiling getter on the delegate denies', () => {
        const user = {
          ...principal('user', 'u1'),
          get ceiling(): Ceiling {
            throw new Error('boom');
          },
        };
        const d = resolveDelegation(principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit' }), undefined, 2);
        expect(d.denial).to.deep.equal({ code: 'delegate', priority: 200, delegate: 'user:u1' });
      });

      it('a throwing getter on another delegate field denies under inherit', () => {
        const user = {
          ...principal('user', 'u1'),
          get attributes(): Record<string, unknown> {
            throw new Error('boom');
          },
        };
        const d = resolveDelegation(principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit' }), undefined, 2);
        expect(d.denial?.code).to.equal('delegate');
      });

      it('a proxy delegate is read once per chain field', () => {
        const reads: Record<string, number> = {};
        const user = new Proxy(principal('user', 'u1', { ceiling: { roles: ['viewer'] } }) as Record<string, unknown>, {
          get(target, key) {
            if (typeof key === 'string') reads[key] = (reads[key] ?? 0) + 1;
            return target[key as string];
          },
        });
        const d = resolveDelegation(principal('agent', 'a1', { onBehalfOf: user as unknown as Principal, delegation: 'inherit' }), undefined, 2);
        expect(d.denial).to.equal(undefined);
        for (const k of ['type', 'id', 'onBehalfOf', 'delegation', 'ceiling']) expect(reads[k], k).to.equal(1);
      });

      it('a ceiling that changes between reads cannot widen the narrowed roles', () => {
        let n = 0;
        const ceiling = {
          get roles(): string[] {
            return n++ === 0 ? ['viewer'] : ['owner'];
          },
        };
        const user = principal('user', 'u1', { ceiling });
        const d = resolveDelegation(principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit' }), undefined, 2);
        expect(roles(d.principal)).to.deep.equal(['viewer']);
        expect(d.ceilings).to.deep.equal([{ roles: ['viewer'] }]);
      });

      it('does not mutate the request principal or the delegates', () => {
        const user = principal('user', 'u1', { ceiling: { roles: ['viewer'] } });
        const agent = principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit', ceiling: { roles: ['owner'] } });
        const before = JSON.stringify(agent);
        resolveDelegation(agent, undefined, 2);
        expect(JSON.stringify(agent)).to.equal(before);
        expect(Object.isFrozen(agent)).to.equal(false);
        expect(Object.isFrozen(user.ceiling)).to.equal(false);
      });
    });
  });

  describe('the narrowed inherit delegate', () => {
    const narrowed = (user: Principal, agentCeiling?: Ceiling): Principal => resolveDelegation(principal('agent', 'a1', { onBehalfOf: user, delegation: 'inherit', ceiling: agentCeiling }), undefined, 2).principal;

    it('intersects roles in the delegate order and dedupes', () => {
      const user = principal('user', 'u1', { ceiling: { roles: ['c', 'a', 'b', 'a'], reason: 'x' } });
      const n = narrowed(user, { roles: ['a', 'c'] });
      expect(n.ceiling).to.deep.equal({ roles: ['c', 'a'], reason: 'x' });
      expect(n).to.not.equal(user);
      expect(Object.isFrozen(n)).to.equal(true);
      expect(n.type).to.equal('user');
    });

    it('disjoint roles leave none', () => {
      expect(roles(narrowed(principal('user', 'u1', { ceiling: { roles: ['a'] } }), { roles: ['b'] }))).to.deep.equal([]);
    });

    it('a malformed agent ceiling leaves no roles', () => {
      expect(roles(narrowed(principal('user', 'u1', { ceiling: { roles: ['a'] } }), 'x' as unknown as Ceiling))).to.deep.equal([]);
    });

    it('null roles count as absent', () => {
      expect(roles(narrowed(principal('user', 'u1', { ceiling: { roles: null as unknown as string[] } }), { roles: ['a'] }))).to.deep.equal(['a']);
    });

    it('keeps own keys named __proto__ as data', () => {
      const user = JSON.parse('{"type":"user","id":"u1","authenticated":true,"source":"t","attributes":{},"__proto__":{"polluted":1}}') as Principal;
      const n = narrowed(user);
      expect((n as unknown as Record<string, unknown>).polluted).to.equal(undefined);
      expect(Object.getPrototypeOf(n)).to.equal(Object.prototype);
    });
  });

  describe('stripPrincipalOps', () => {
    const c = (field: string): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value: 1 });
    const rel: ResourceFilter = { op: 'relation', relation: 'owner' };
    const nat: ResourceFilter = { op: 'native:geo', args: { r: 1 } };

    it('replaces principal ops by polarity', () => {
      expect(stripPrincipalOps(rel)).to.equal(FALSE);
      expect(stripPrincipalOps(nat)).to.equal(FALSE);
      expect(stripPrincipalOps({ op: 'not', arg: rel })).to.equal(FALSE);
      expect(stripPrincipalOps({ op: 'not', arg: { op: 'not', arg: rel } })).to.equal(FALSE);
      expect(stripPrincipalOps({ op: 'and', args: [c('a'), rel] })).to.equal(FALSE);
      expect(stripPrincipalOps({ op: 'or', args: [c('a'), rel] })).to.deep.equal(c('a'));
      expect(stripPrincipalOps({ op: 'or', args: [c('a'), { op: 'not', arg: nat }] })).to.deep.equal(c('a'));
      expect(stripPrincipalOps({ op: 'not', arg: { op: 'and', args: [c('a'), rel] } })).to.deep.equal({ op: 'not', arg: c('a') });
      expect(stripPrincipalOps({ op: 'not', arg: { op: 'or', args: [c('a'), rel] } })).to.equal(FALSE);
    });

    it('keeps other nodes, by identity', () => {
      const a = c('a');
      const u: ResourceFilter = { op: 'under', scopes: [{ type: 'org', id: 'o1' }] };
      expect(stripPrincipalOps(a)).to.equal(a);
      expect(stripPrincipalOps(u)).to.equal(u);
      expect(stripPrincipalOps(TRUE)).to.equal(TRUE);
      const both = stripPrincipalOps({ op: 'and', args: [a, u] }) as { args: readonly ResourceFilter[] };
      expect(both.args[0]).to.equal(a);
      expect(both.args[1]).to.equal(u);
    });

    it('malformed nodes are replaced fail-closed', () => {
      expect(stripPrincipalOps(null as unknown as ResourceFilter)).to.equal(FALSE);
      expect(stripPrincipalOps({ op: 'not', arg: null } as unknown as ResourceFilter)).to.equal(FALSE);
      expect(stripPrincipalOps({ op: 'or', args: [c('a'), { op: 'weird' }] } as unknown as ResourceFilter)).to.deep.equal(c('a'));
      expect(stripPrincipalOps({ op: 'and', args: 'x' } as unknown as ResourceFilter)).to.equal(FALSE);
      expect(stripPrincipalOps({ op: 'or', args: [c('a'), , c('b')] } as unknown as ResourceFilter)).to.deep.equal({ op: 'or', args: [c('a'), c('b')] }); // eslint-disable-line no-sparse-arrays
      const throwing = {
        get op(): string {
          throw new Error('x');
        },
      } as unknown as ResourceFilter;
      expect(stripPrincipalOps(throwing)).to.equal(FALSE);
      expect(stripPrincipalOps({ op: 'not', arg: throwing })).to.equal(FALSE);
    });

    it('does not mutate its input', () => {
      const f = { op: 'and', args: [c('a'), { op: 'not', arg: rel }] } as ResourceFilter;
      const before = JSON.stringify(f);
      stripPrincipalOps(f);
      expect(JSON.stringify(f)).to.equal(before);
      expect(Object.isFrozen(f)).to.equal(false);
    });

    it('a shared-subtree DAG of depth 30 finishes fast', () => {
      let raw: ResourceFilter = { op: 'or', args: [c('x'), rel] };
      let built: ResourceFilter = or(c('x'), { op: 'relation', relation: 'r' });
      for (let i = 0; i < 30; i++) {
        raw = {
          op: 'or',
          args: [
            { op: 'and', args: [raw, c(`c${i}`)] },
            { op: 'and', args: [raw, { op: 'not', arg: raw }] },
          ],
        };
        built = or(and(built, c(`c${i}`)), and(built, not(built)), { op: 'native:n', args: i });
      }
      const started = Date.now();
      stripPrincipalOps(raw);
      stripPrincipalOps(built);
      expect(Date.now() - started).to.be.lessThan(5000);
    });

    it('nesting deeper than the limit and cycles terminate fail-closed', () => {
      let deep: ResourceFilter = c('a');
      for (let i = 0; i < 10_000; i++) deep = { op: 'not', arg: { op: 'not', arg: deep } };
      expect(stripPrincipalOps(deep)).to.equal(FALSE);

      const cyc = { op: 'not' } as { op: 'not'; arg: ResourceFilter };
      cyc.arg = cyc;
      expect(() => stripPrincipalOps(cyc)).to.not.throw();
    });

    describe('property: it only narrows (Kleene)', () => {
      type K = boolean | undefined;
      const rank = (k: K) => (k === false ? 0 : k === undefined ? 1 : 2);

      const leafKey = (f: ResourceFilter): string => {
        switch (f.op) {
          case 'cmp':
            return `cmp:${f.field}`;
          case 'relation':
            return `rel:${f.relation}`;
          case 'under':
            return 'under';
          default:
            return f.op;
        }
      };

      const kleene = (f: ResourceFilter, at: Record<string, K>): K => {
        switch (f.op) {
          case 'true':
            return true;
          case 'false':
            return false;
          case 'not': {
            const v = kleene(f.arg, at);
            return v === undefined ? undefined : !v;
          }
          case 'and': {
            const vs = f.args.map((x) => kleene(x, at));
            return vs.includes(false) ? false : vs.includes(undefined) ? undefined : true;
          }
          case 'or': {
            const vs = f.args.map((x) => kleene(x, at));
            return vs.includes(true) ? true : vs.includes(undefined) ? undefined : false;
          }
          default:
            return at[leafKey(f)];
        }
      };

      const LEAVES = ['cmp:a', 'cmp:b', 'cmp:c', 'rel:owner', 'rel:member', 'native:geo', 'native:ip', 'under'];
      const leafArb: fc.Arbitrary<ResourceFilter> = fc.constantFrom<ResourceFilter>({ op: 'cmp', field: 'a', cmp: 'eq', value: 1 }, { op: 'cmp', field: 'b', cmp: 'eq', value: 1 }, { op: 'cmp', field: 'c', cmp: 'gt', value: 2 }, { op: 'relation', relation: 'owner' }, { op: 'relation', relation: 'member' }, { op: 'native:geo', args: 1 }, { op: 'native:ip' }, { op: 'under', scopes: [{ type: 'org', id: 'o1' }] }, TRUE, FALSE);
      const { tree } = fc.letrec<{ tree: ResourceFilter }>((tie) => ({
        tree: fc.oneof({ depthSize: 'small', withCrossShrink: true }, leafArb, fc.record({ op: fc.constantFrom('and' as const, 'or' as const), args: fc.array(tie('tree'), { minLength: 0, maxLength: 4 }) }), fc.record({ op: fc.constant('not' as const), arg: tie('tree') })),
      }));
      const truthArb = fc.constantFrom<K>(true, false, undefined);
      const assignmentArb = fc.record(Object.fromEntries(LEAVES.map((k) => [k, truthArb])) as Record<string, fc.Arbitrary<K>>);

      it('leaves no relation or native node behind', () => {
        const principalOps = (f: ResourceFilter): boolean => {
          if (f.op === 'relation' || f.op.startsWith('native:')) return true;
          if (f.op === 'and' || f.op === 'or') return f.args.some(principalOps);
          if (f.op === 'not') return principalOps(f.arg);
          return false;
        };
        fc.assert(
          fc.property(tree, (f) => {
            expect(principalOps(stripPrincipalOps(f))).to.equal(false);
          }),
          { numRuns: 300 },
        );
      });

      it('never ranks above the original under any assignment of the leaves', () => {
        fc.assert(
          fc.property(tree, assignmentArb, (f, at) => {
            const stripped = kleene(stripPrincipalOps(f), at);
            const original = kleene(f, at);
            expect(rank(stripped)).to.be.at.most(rank(original));
            if (stripped === true) expect(original).to.equal(true);
          }),
          { numRuns: 500 },
        );
      });

      it('equals the original when no principal op is present', () => {
        fc.assert(
          fc.property(tree, assignmentArb, (f, at) => {
            const hasPrincipalOp = JSON.stringify(f).includes('"relation"') || JSON.stringify(f).includes('native:');
            fc.pre(!hasPrincipalOp);
            expect(kleene(stripPrincipalOps(f), at)).to.equal(kleene(f, at));
          }),
          { numRuns: 300 },
        );
      });
    });
  });
});
