import { expect } from 'chai';
import 'mocha';
import * as fc from 'fast-check';

import { FALSE, GLOBAL, PERMISSION_GLOB_PATTERN, PERMISSION_PATTERN, SYSTEM, UNATTENDED, isPermissionGlob, resourceKey } from '@spinajs/authz';
import type { ResourceFilter } from '@spinajs/authz';

import { FakeAdapter, FakeScopeResolver, assignment, cap, ceiling, evaluateFilter, filter, ladder, permissionGlob, permissionName, principal, principalRef, resourceRef, restriction, roleGraph, row, scopeTree, vote, denyReason } from '../src/index.js';
import type { TestRoleDef } from '../src/index.js';

const assertProperty = <T>(arb: fc.Arbitrary<T>, check: (v: T) => void, numRuns = 150): void =>
  fc.assert(
    fc.property(arb, (v) => {
      check(v);
    }),
    { numRuns },
  );

const walk = (f: ResourceFilter, visit: (f: ResourceFilter) => void): void => {
  visit(f);
  if (f.op === 'and' || f.op === 'or') f.args.forEach((a) => walk(a, visit));
  else if (f.op === 'not') walk(f.arg, visit);
};

const depthOf = (f: ResourceFilter): number => (f.op === 'and' || f.op === 'or' ? 1 + Math.max(0, ...f.args.map(depthOf)) : f.op === 'not' ? 1 + depthOf(f.arg) : 0);

const hasCycle = (roles: readonly TestRoleDef[]): boolean => {
  const byName = new Map(roles.map((r) => [r.name, r]));
  const state = new Map<string, 1 | 2>();
  const visit = (name: string): boolean => {
    if (state.get(name) === 1) return true;
    if (state.get(name) === 2) return false;
    state.set(name, 1);
    const found = (byName.get(name)?.extends ?? []).some(visit);
    state.set(name, 2);
    return found;
  };
  return roles.some((r) => visit(r.name));
};

describe('arbitraries', () => {
  describe('permissions', () => {
    it('names match PERMISSION_PATTERN, also from a custom pool', () => {
      assertProperty(permissionName(), (n) => expect(PERMISSION_PATTERN.test(n)).to.eq(true));
      assertProperty(permissionName({ pool: ['x:y'] }), (n) => expect(n).to.eq('x:y'));
    });

    it('globs match PERMISSION_GLOB_PATTERN and never contain **', () => {
      assertProperty(permissionGlob(), (g) => {
        expect(PERMISSION_GLOB_PATTERN.test(g)).to.eq(true);
        expect(isPermissionGlob(g)).to.eq(true);
        expect(g).to.not.include('**');
      });
    });
  });

  describe('refs and principals', () => {
    it('resourceRef draws from the given types and ids, with and without an id', () => {
      assertProperty(resourceRef({ types: ['t1', 't2'], ids: ['i'] }), (r) => {
        expect(['t1', 't2']).to.include(r.type);
        if (r.id !== undefined) expect(r.id).to.eq('i');
      });
      assertProperty(resourceRef({ typeLevel: false }), (r) => expect(r.id).to.be.a('string'));
      const seen = fc.sample(resourceRef(), { numRuns: 200, seed: 1 });
      expect(seen.some((r) => r.id === undefined)).to.eq(true);
      expect(seen.some((r) => r.id !== undefined)).to.eq(true);
    });

    it('principalRef has a type and an id from the pool', () => {
      assertProperty(principalRef({ ids: ['x'] }), (p) => {
        expect(p.type).to.be.a('string');
        expect(p.id).to.eq('x');
      });
    });

    it('ceiling fields are independently absent, empty or filled, and valid', () => {
      const all = fc.sample(ceiling(), { numRuns: 300, seed: 2 });
      for (const key of ['roles', 'permissions', 'resources'] as const) {
        expect(all.some((c) => c[key] === undefined), `${key} absent`).to.eq(true);
        expect(all.some((c) => c[key]?.length === 0), `${key} []`).to.eq(true);
        expect(all.some((c) => (c[key]?.length ?? 0) > 0), `${key} filled`).to.eq(true);
      }
      expect(all.some((c) => c.expiresAt instanceof Date)).to.eq(true);
      assertProperty(ceiling(), (c) => {
        for (const g of c.permissions ?? []) expect(isPermissionGlob(g)).to.eq(true);
        if (c.expiresAt) expect(Number.isNaN(c.expiresAt.getTime())).to.eq(false);
      });
    });

    it('principal covers every kind, agents speak for a delegate, objects are frozen singletons-safe', () => {
      const all = fc.sample(principal(), { numRuns: 300, seed: 3 });
      expect(new Set(all.map((p) => p.type))).to.deep.eq(new Set(['user', 'service', 'group', 'link', 'agent']));
      for (const p of all) {
        expect(Object.isFrozen(p)).to.eq(true);
        expect(p.type).to.not.eq('system');
        expect(p.attributes).to.be.an('object');
        if (p.type === 'agent') {
          expect(p.onBehalfOf?.type).to.eq('user');
          expect(['inherit', 'intersect']).to.include(p.delegation);
        }
        else expect(p.onBehalfOf).to.eq(undefined);
        if (p.type === 'link') expect(p.ceiling?.resources?.length).to.be.greaterThan(0);
      }
      expect(all.some((p) => p.ceiling === undefined)).to.eq(true);
    });

    it('ceiling resources always carry an id, even when type-level refs are the default elsewhere', () => {
      for (const c of fc.sample(ceiling(), { numRuns: 300, seed: 21 })) for (const r of c.resources ?? []) expect(r.id).to.be.a('string');
    });

    it('about a third of principals carry a ceiling, and few of those admit nothing by construction', () => {
      const all = fc.sample(principal({ kinds: ['user', 'service', 'group'] }), { numRuns: 1500, seed: 22 });
      const withCeiling = all.filter((p) => p.ceiling !== undefined).length / all.length;
      expect(withCeiling).to.be.within(0.2, 0.5);
      const nothing = all.filter((p) => p.ceiling && Object.values(p.ceiling).some((v) => Array.isArray(v) && v.length === 0)).length / all.length;
      expect(nothing).to.be.below(0.25);
    });

    it('principal offers SYSTEM and UNATTENDED by identity only when named', () => {
      const named = fc.sample(principal({ kinds: ['system', 'unattended'] }), { numRuns: 60, seed: 23 });
      expect(named.some((p) => p === SYSTEM)).to.eq(true);
      expect(named.some((p) => p === UNATTENDED)).to.eq(true);
      expect(named.every((p) => p === SYSTEM || p === UNATTENDED)).to.eq(true);
    });

    it('principalRef covers link subjects by default; an empty kinds pool throws', () => {
      expect(fc.sample(principalRef(), { numRuns: 200, seed: 24 }).some((p) => p.type === 'link')).to.eq(true);
      expect(() => principalRef({ kinds: [] })).to.throw(/empty/);
      expect(() => principal({ kinds: [] })).to.throw(/empty/);
    });

    it('dates are drawn around `now`, both past and future', () => {
      const now = new Date('2026-06-15T12:00:00Z');
      const dates = fc
        .sample(ceiling({ now }), { numRuns: 600, seed: 25 })
        .map((c) => c.expiresAt)
        .filter((d): d is Date => d instanceof Date);
      expect(dates.length).to.be.greaterThan(20);
      expect(dates.some((d) => d < now)).to.eq(true);
      expect(dates.some((d) => d > now)).to.eq(true);
      for (const d of dates) expect(Math.abs(d.getTime() - now.getTime())).to.be.at.most(30 * 86_400_000);
      const assigned = fc.sample(assignment({ now }), { numRuns: 300, seed: 26 }).map((a) => a.expiresAt);
      expect(assigned.some((d) => d instanceof Date && d < now)).to.eq(true);
      expect(assigned.some((d) => d instanceof Date && d > now)).to.eq(true);
    });

    it('principal respects kinds and the ceiling switch', () => {
      assertProperty(principal({ kinds: ['user'], ceiling: true }), (p) => {
        expect(p.type).to.eq('user');
        expect(p.ceiling).to.not.eq(undefined);
      });
      assertProperty(principal({ kinds: ['service', 'group', 'agent'], ceiling: false }), (p) => expect(p.ceiling).to.eq(undefined));
    });
  });

  describe('filters', () => {
    it('only use the ops asked for', () => {
      const ops = ['and', 'not', 'cmp', 'true'] as const;
      assertProperty(filter({ ops }), (f) => walk(f, (n) => expect(ops as readonly string[]).to.include(n.op)));
      assertProperty(filter({ ops: ['relation'], depth: 0 }), (f) => expect(f.op).to.eq('relation'));
    });

    it('natives appear only when named', () => {
      assertProperty(filter({}), (f) => walk(f, (n) => expect(n.op.startsWith('native:')).to.eq(false)));
      const seen = new Set<string>();
      for (const f of fc.sample(filter({ nativeOps: ['native:fake.tuple'] }), { numRuns: 300, seed: 4 })) walk(f, (n) => seen.add(n.op));
      expect(seen.has('native:fake.tuple')).to.eq(true);
    });

    it('cover every op and every comparator, with null and ref values', () => {
      const ops = new Set<string>();
      const cmps = new Set<string>();
      let literalNull = false;
      let ref = false;
      for (const f of fc.sample(filter({ nativeOps: ['native:x'] }), { numRuns: 1500, seed: 5 })) {
        walk(f, (n) => {
          ops.add(n.op);
          if (n.op === 'cmp') {
            cmps.add(n.cmp);
            if (n.value === null) literalNull = true;
            if (n.value !== null && typeof n.value === 'object' && !Array.isArray(n.value)) ref = true;
          }
        });
      }
      expect([...ops].sort()).to.deep.eq(['and', 'cmp', 'false', 'native:x', 'not', 'or', 'relation', 'true', 'under']);
      expect([...cmps].sort()).to.deep.eq(['eq', 'glob', 'gt', 'gte', 'in', 'like', 'lt', 'lte', 'ne', 'nin', 'notnull', 'null', 'wildcard']);
      expect(literalNull).to.eq(true);
      expect(ref).to.eq(true);
    });

    it('respect depth, fields, relations, scopes and literal-only values', () => {
      const scopes = [{ type: 'org', id: 'o1' }];
      assertProperty(filter({ depth: 2, fields: ['f'], relations: ['r'], scopes, refs: [], values: ['v'] }), (f) => {
        expect(depthOf(f)).to.be.at.most(2);
        walk(f, (n) => {
          if (n.op === 'cmp') {
            expect(n.field).to.eq('f');
            expect(n.value === null || typeof n.value !== 'object' || Array.isArray(n.value)).to.eq(true);
          }
          if (n.op === 'relation') expect(n.relation).to.eq('r');
          if (n.op === 'under') n.scopes.forEach((s) => expect(s).to.deep.eq(scopes[0]));
        });
      });
    });

    it('keep the TRUE/FALSE singletons', () => {
      const f = fc.sample(filter({ ops: ['true', 'false'], depth: 0 }), { numRuns: 50, seed: 6 });
      expect(f.every((x) => Object.isFrozen(x))).to.eq(true);
      expect(f.some((x) => x === FALSE)).to.eq(true);
    });

    it('an empty pool means none: the op that needs it is dropped', () => {
      for (const f of fc.sample(filter({ relations: [], scopes: [], fields: [] }), { numRuns: 300, seed: 31 })) {
        walk(f, (n) => expect(['relation', 'under', 'cmp']).to.not.include(n.op));
      }
      for (const f of fc.sample(filter({ values: [], refs: [] }), { numRuns: 300, seed: 32 })) {
        walk(f, (n) => {
          if (n.op === 'cmp' && n.value !== undefined && n.value !== null) expect(typeof n.value === 'boolean' || (Array.isArray(n.value) && n.value.length === 0)).to.eq(true);
        });
      }
      expect(() => filter({ fields: ['tags.0'] })).to.throw(/array index/);
      expect(() => filter({ fields: ['a.b.12.c'] })).to.throw(/array index/);
      expect(() => row({ fields: ['tags.0'] })).to.throw(/array index/);
      expect(() => vote({ fields: ['x.1'] })).to.throw(/array index/);
      expect(() => filter({ fields: ['a1.b2'] })).to.not.throw();
      for (const r of fc.sample(row({ fields: [] }), { numRuns: 20, seed: 33 })) expect(Object.keys(r)).to.deep.eq(['id']);
    });

    describe('with invalid', () => {
      const refs = ['r.a', 'r.b'];
      const finite = (v: unknown): boolean => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
      const validRef = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && refs.includes((v as { ref?: string }).ref as string);
      const validValue = (v: unknown): boolean => {
        if (v === null || finite(v)) return true;
        if (Array.isArray(v)) return Object.keys(v).length === v.length && v.every((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)));
        return validRef(v);
      };
      const values = (opts: { invalid?: boolean }): unknown[] => {
        const out: unknown[] = [];
        for (const f of fc.sample(filter({ refs, ...opts }), { numRuns: 800, seed: 41 })) walk(f, (n) => n.op === 'cmp' && n.value !== undefined && out.push(n.value));
        return out;
      };

      it('are off by default: every value is a valid literal, list or listed ref', () => {
        const all = values({});
        expect(all.length).to.be.greaterThan(100);
        for (const v of all) expect(validValue(v), JSON.stringify(v)).to.eq(true);
        expect(all.some((v) => validRef(v))).to.eq(true);
      });

      it('mix in bad lists, junk scalars and malformed refs when asked', () => {
        const all = values({ invalid: true });
        const bad = all.filter((v) => !validValue(v));
        expect(bad.length).to.be.greaterThan(10);
        expect(bad.length / all.length).to.be.below(0.4);
        expect(bad.some((v) => Array.isArray(v))).to.eq(true);
        expect(bad.some((v) => typeof v === 'object' && v !== null && !Array.isArray(v) && 'ref' in v)).to.eq(true);
        expect(all.some((v) => validValue(v))).to.eq(true);
      });

      it('votes pass the option on', () => {
        let bad = false;
        for (const v of fc.sample(vote({ invalid: true }), { numRuns: 300, seed: 42 })) walk(v.permitWhen, (n) => n.op === 'cmp' && n.value !== undefined && !validValue(n.value) && (bad = true));
        expect(bad).to.eq(true);
      });
    });

    it('rows carry an id and only the asked fields', () => {
      assertProperty(row({ fields: ['f', 'g'], values: ['v'] }), (r) => {
        expect(r.id).to.be.a('string');
        for (const k of Object.keys(r)) expect(['id', 'f', 'g']).to.include(k);
        for (const k of ['f', 'g']) if (k in r) expect(r[k] === 'v' || r[k] === null).to.eq(true);
      });
    });

    it('every filter evaluates against every row without throwing', async () => {
      const p = principal({ kinds: ['user'] });
      await fc.assert(
        fc.asyncProperty(filter({ relations: [] }), row(), p, async (f, r, who) => {
          const out = await evaluateFilter(f, r, { principal: who, ref: { type: 'file', id: r.id }, env: { now: new Date(0) } });
          expect([true, false, null]).to.include(out);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('votes', () => {
    it('denyWhen is the OR of the denies, every reason carries the model', () => {
      assertProperty(vote({ model: 'rbac' }), (v) => {
        expect(v.model).to.eq('rbac');
        expect(v.cacheable).to.be.a('boolean');
        if (v.denies) {
          expect(v.denies.length).to.be.greaterThan(0);
          expect(v.denyWhen).to.deep.eq({ op: 'or', args: v.denies.map((d: { when: ResourceFilter }) => d.when) });
          for (const d of v.denies) expect(d.reason.model).to.eq('rbac');
        }
        if (v.validUntil) expect(Number.isNaN(v.validUntil.getTime())).to.eq(false);
      });
    });

    it('most votes are normal ones: error is rare', () => {
      const all = fc.sample(vote(), { numRuns: 2000, seed: 51 });
      const errors = all.filter((v) => v.error !== undefined).length / all.length;
      expect(errors).to.be.within(0.03, 0.2);
      const clean3 = fc.sample(fc.array(vote(), { minLength: 3, maxLength: 3 }), { numRuns: 500, seed: 52 }).filter((vs) => vs.every((v) => v.error === undefined)).length / 500;
      expect(clean3).to.be.greaterThan(0.5);
    });

    it('cover denies, error, fields, validUntil, reason, both cacheable values and uncombined denyWhen', () => {
      const all = fc.sample(vote(), { numRuns: 400, seed: 7 });
      expect(all.some((v) => v.denies)).to.eq(true);
      expect(all.some((v) => !v.denies)).to.eq(true);
      expect(all.some((v) => v.error)).to.eq(true);
      expect(all.some((v) => v.fields)).to.eq(true);
      expect(all.some((v) => v.validUntil)).to.eq(true);
      expect(all.some((v) => v.reason)).to.eq(true);
      expect(all.some((v) => v.cacheable)).to.eq(true);
      expect(all.some((v) => !v.cacheable)).to.eq(true);
      expect(fc.sample(vote({ errors: false }), { numRuns: 200, seed: 8 }).every((v) => v.error === undefined)).to.eq(true);
      expect(fc.sample(vote({ maxDenies: 0 }), { numRuns: 100, seed: 8 }).every((v) => v.denies === undefined)).to.eq(true);
    });

    it('denyReason has a code, optional finite priority and sortKey', () => {
      assertProperty(denyReason({ codes: ['x', 'y'] }), (r) => {
        expect(r.code).to.be.a('string').and.not.eq('');
        if (r.priority !== undefined) expect(Number.isInteger(r.priority)).to.eq(true);
        expect(r.model).to.eq(undefined);
      });
      const all = fc.sample(denyReason(), { numRuns: 200, seed: 9 });
      expect(all.some((r) => r.priority !== undefined) && all.some((r) => r.priority === undefined)).to.eq(true);
      expect(all.some((r) => r.sortKey !== undefined)).to.eq(true);
    });
  });

  describe('role graphs, ladders, rules, assignments', () => {
    it('roleGraph is acyclic by default, with unique names and edges to existing roles', () => {
      assertProperty(roleGraph({ roles: 6, maxExtends: 3 }), (roles: TestRoleDef[]) => {
        expect(roles).to.have.length(6);
        const names = new Set(roles.map((r) => r.name));
        expect(names.size).to.eq(6);
        for (const r of roles) {
          expect(r.extends.length).to.be.at.most(3);
          expect(new Set(r.extends).size).to.eq(r.extends.length);
          for (const e of r.extends) expect(names.has(e)).to.eq(true);
          for (const g of r.grants) expect(PERMISSION_PATTERN.test(g.permission) || isPermissionGlob(g.permission)).to.eq(true);
          expect(r.assignable).to.be.a('boolean');
        }
        expect(hasCycle(roles)).to.eq(false);
      });
    });

    it('roleGraph takes exact names and permission pools', () => {
      assertProperty(roleGraph({ roles: ['a', 'b'], permissions: ['p:q'], globs: false }), (roles: TestRoleDef[]) => {
        expect(roles.map((r) => r.name).sort()).to.deep.eq(['a', 'b']);
        for (const r of roles) for (const g of r.grants) expect(g.permission).to.eq('p:q');
      });
      expect(fc.sample(roleGraph({ roles: [] }), { numRuns: 5, seed: 60 }).every((g) => g.length === 0)).to.eq(true);
      expect(fc.sample(roleGraph({ permissions: [] }), { numRuns: 50, seed: 61 }).every((g) => g.every((r) => r.grants.length === 0))).to.eq(true);
      expect(fc.sample(roleGraph({ types: [] }), { numRuns: 50, seed: 62 }).every((g) => g.every((r) => r.scopeTypes === undefined))).to.eq(true);
    });

    it('grants mix in permission globs, on-patterns with ids and hidden fields', () => {
      const grants = fc.sample(roleGraph({ roles: 4 }), { numRuns: 200, seed: 63 }).flatMap((g) => g.flatMap((r) => [...r.grants]));
      expect(grants.some((g) => g.permission.includes('*'))).to.eq(true);
      expect(grants.some((g) => !g.permission.includes('*'))).to.eq(true);
      expect(grants.some((g) => g.on?.some((o) => o.id?.includes('{principal.')))).to.eq(true);
      expect(grants.some((g) => g.on?.some((o) => o.id === undefined))).to.eq(true);
      expect(grants.some((g) => (g.fields?.hide?.length ?? 0) > 0)).to.eq(true);
    });

    it('role graphs carry implied roles and descriptions; implies stays acyclic like extends', () => {
      const graphs = fc.sample(roleGraph({ roles: 5, maxExtends: 3 }), { numRuns: 200, seed: 64 });
      const roles = graphs.flat();
      expect(roles.some((r) => r.implies?.some((i) => i.at === 'descendants'))).to.eq(true);
      expect(roles.some((r) => r.implies?.some((i) => i.at === 'self-and-descendants'))).to.eq(true);
      expect(roles.some((r) => r.implies?.some((i) => (i.bypass?.length ?? 0) > 0 && (i.tags?.length ?? 0) > 0))).to.eq(true);
      expect(roles.some((r) => r.description !== undefined)).to.eq(true);
      for (const g of graphs) {
        const names = new Set(g.map((r) => r.name));
        for (const r of g) for (const i of r.implies ?? []) expect(names.has(i.role)).to.eq(true);
        expect(hasCycle(g.map((r) => ({ ...r, extends: [...r.extends, ...(r.implies ?? []).map((i) => i.role)] })))).to.eq(false);
      }
    });

    it('dangling: false never names unknown roles; true sometimes does', () => {
      const unknown = (g: TestRoleDef[]): boolean => g.some((r) => [...r.extends, ...(r.implies ?? []).map((i) => i.role)].some((n) => !g.some((x) => x.name === n)));
      expect(fc.sample(roleGraph({ roles: 4 }), { numRuns: 300, seed: 65 }).some(unknown)).to.eq(false);
      expect(fc.sample(roleGraph({ roles: 4, dangling: true }), { numRuns: 300, seed: 66 }).some(unknown)).to.eq(true);
    });

    it('roleGraph with acyclic: false yields a cycle for some seed', () => {
      const all = fc.sample(roleGraph({ roles: 3, maxExtends: 2, acyclic: false }), { numRuns: 300, seed: 10 });
      expect(all.some(hasCycle)).to.eq(true);
      expect(all.some((g) => !hasCycle(g))).to.eq(true);
    });

    it('ladder roles carry the ladder name and follow its order', () => {
      assertProperty(ladder(), ({ ladder: l, roles }) => {
        expect(l.roles.length).to.be.at.least(2);
        expect(new Set(l.roles).size).to.eq(l.roles.length);
        expect(roles.map((r: TestRoleDef) => r.name)).to.deep.eq(l.roles);
        for (const r of roles) expect(r.ladder).to.eq(l.name);
      });
    });

    it('cap and restriction produce the right rule kinds', () => {
      assertProperty(cap({ roles: ['viewer', 'owner'], ladders: ['project'] }), (r) => {
        expect(r.kind).to.eq('cap');
        expect(r.ladder).to.eq('project');
        expect(r.maxRole === null || typeof r.maxRole === 'string' || typeof (r.maxRole as { ref: string }).ref === 'string').to.eq(true);
        if (typeof r.maxRole === 'string') expect(['viewer', 'owner']).to.include(r.maxRole);
        expect(r.source).to.be.a('string');
      });
      const caps = fc.sample(cap(), { numRuns: 300, seed: 11 });
      expect(caps.some((r) => r.maxRole === null)).to.eq(true);
      expect(caps.some((r) => r.maxRole !== null && typeof r.maxRole === 'object')).to.eq(true);
      expect(caps.some((r) => typeof r.maxRole === 'string')).to.eq(true);
      expect(caps.some((r) => r.stripTags === true)).to.eq(true);

      assertProperty(restriction(), (r) => {
        expect(r.kind).to.eq('restrict');
        expect(r.allow).to.be.an('array');
      });
      expect(fc.sample(restriction(), { numRuns: 300, seed: 12 }).some((r) => r.allow?.some((s) => 'set' in s))).to.eq(true);
    });

    it('rule scopes use GLOBAL for the root and refs with ids elsewhere', () => {
      const scopes = fc.sample(cap(), { numRuns: 200, seed: 13 }).map((r) => r.scope);
      expect(scopes.some((s) => s === GLOBAL)).to.eq(true);
      for (const s of scopes) if (s !== GLOBAL) expect(s.id).to.be.a('string');
    });

    it('assignment draws subjects, roles and scopes from the pools', () => {
      const scopes = [GLOBAL, { type: 'org', id: 'o1' }];
      assertProperty(assignment({ roles: ['viewer'], scopes, ids: ['u1'] }), (a) => {
        expect(a.role).to.eq('viewer');
        expect(scopes.map(resourceKey)).to.include(resourceKey(a.scope));
        if ('set' in a.subject) {
          expect(a.subject.set.role).to.eq('viewer');
          expect(scopes.map(resourceKey)).to.include(resourceKey(a.subject.set.scope));
        } else {
          expect(a.subject.id).to.eq('u1');
        }
      });
      const all = fc.sample(assignment(), { numRuns: 300, seed: 14 });
      expect(all.some((a) => 'set' in a.subject)).to.eq(true);
      expect(all.some((a) => a.expiresAt === null)).to.eq(true);
      expect(all.some((a) => a.expiresAt instanceof Date)).to.eq(true);
      expect(all.some((a) => a.expiresAt === undefined)).to.eq(true);
      assertProperty(assignment({ sets: false }), (a) => expect('set' in a.subject).to.eq(false));
      expect(all.some((a) => !('set' in a.subject) && a.subject.type === 'link')).to.eq(true);
      expect(all.some((a) => a.tags?.length === 0)).to.eq(true);
    });
  });

  describe('scopeTree', () => {
    it('builds a typed tree with unique ids, parents before children and no GLOBAL parent', () => {
      assertProperty(scopeTree({ types: ['org', 'project', 'file'], depth: 3, width: 3 }), (t) => {
        const keys = t.nodes.map(resourceKey);
        expect(new Set(keys).size).to.eq(keys.length);
        const seen = new Set<string>();
        const order = ['org', 'project', 'file'];
        for (const [child, parent] of t.parents) {
          expect(order.indexOf(child.type)).to.eq(order.indexOf(parent.type) + 1);
          expect(keys).to.include(resourceKey(parent));
        }
        for (const n of t.nodes) {
          seen.add(resourceKey(n));
        }
        for (const r of t.roots) expect(r.type).to.eq('org');
        expect(t.parents.length + t.roots.length).to.eq(t.nodes.length);
        for (const [, p] of t.parents) expect(resourceKey(p)).to.not.eq(resourceKey(GLOBAL));
      });
    });

    it('respects width and depth', () => {
      assertProperty(scopeTree({ depth: 2, width: 2 }), (t) => {
        expect(t.roots.length).to.be.at.most(2);
        expect(new Set(t.nodes.map((n) => n.type)).size).to.be.at.most(2);
        const children = new Map<string, number>();
        for (const [, p] of t.parents) children.set(resourceKey(p), (children.get(resourceKey(p)) ?? 0) + 1);
        for (const c of children.values()) expect(c).to.be.at.most(2);
      });
    });

    it('has a row per node, and few trees are empty by default', () => {
      assertProperty(scopeTree({ depth: 3 }), (t) => {
        expect(t.roots.length).to.be.at.least(1);
        expect(Object.values(t.rows).flat()).to.have.length(t.nodes.length);
        for (const n of t.nodes) expect(t.rows[n.type].some((r) => r.id === n.id)).to.eq(true);
      });
      const empty = fc.sample(scopeTree({ minRoots: 0 }), { numRuns: 300, seed: 16 }).some((t) => t.nodes.length === 0);
      expect(empty).to.eq(true);
    });

    it('feeds FakeScopeResolver and FakeAdapter alike: the same ancestors for every node, ending in GLOBAL', async () => {
      const types = ['org', 'project', 'folder', 'file'];
      await fc.assert(
        fc.asyncProperty(scopeTree({ types, depth: 4 }), async (tree) => {
          const resolver = new FakeScopeResolver({ nodes: tree.scopeNodes });
          const adapter = new FakeAdapter({ types, rows: tree.rows, parents: tree.parents });
          for (const n of tree.nodes) {
            const chain = await resolver.ancestors(n);
            expect(chain![0]).to.deep.eq(n);
            expect(chain![chain!.length - 1]).to.eq(GLOBAL);
            expect(chain!.filter((c) => c === GLOBAL)).to.have.length(1);
            expect(await adapter.ancestors(n)).to.deep.eq(chain);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('determinism', () => {
    const arbs: Record<string, fc.Arbitrary<unknown>> = {
      permissionName: permissionName(),
      permissionGlob: permissionGlob(),
      resourceRef: resourceRef(),
      principalRef: principalRef(),
      principal: principal(),
      ceiling: ceiling(),
      filter: filter({ nativeOps: ['native:x'] }),
      row: row(),
      vote: vote(),
      denyReason: denyReason(),
      roleGraph: roleGraph(),
      cyclicRoleGraph: roleGraph({ acyclic: false }),
      ladder: ladder(),
      cap: cap(),
      restriction: restriction(),
      assignment: assignment(),
      scopeTree: scopeTree(),
    };

    for (const [name, arb] of Object.entries(arbs)) {
      it(`${name} gives the same samples for the same seed`, () => {
        const a = fc.sample(arb, { numRuns: 25, seed: 4242 });
        const b = fc.sample(arb, { numRuns: 25, seed: 4242 });
        expect(a).to.deep.eq(b);
        expect(fc.sample(arb, { numRuns: 25, seed: 4243 })).to.not.deep.eq(a);
      });
    }
  });
});
