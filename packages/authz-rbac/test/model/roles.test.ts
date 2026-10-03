import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import { arb } from '@spinajs/authz-testing';
import * as chai from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { assignmentProblem, compileRoles } from '../../src/index.js';
import type { CompileRolesOptions, GrantDef, ImpliedRole, LadderDef, RoleDef, RoleEdge, RoleGraph } from '../../src/index.js';

const expect = chai.expect;

type TestGrantDef = arb.TestGrantDef;
type TestImpliedRole = arb.TestImpliedRole;
type TestLadderDef = arb.TestLadderDef;
type TestRoleDef = arb.TestRoleDef;

type Extra = Partial<Omit<RoleDef, 'name' | 'grants'>>;
const role = (name: string, grants: readonly string[] = [], extra: Extra = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((permission) => ({ permission })) });

const refusesWith = (opts: CompileRolesOptions, roles: readonly unknown[], ladders: readonly LadderDef[] = []): AuthzConfigError => {
  let caught: unknown;
  try {
    compileRoles(roles as RoleDef[], ladders, opts);
  } catch (err) {
    caught = err;
  }
  expect(caught, 'compileRoles should throw').to.be.instanceOf(AuthzConfigError);
  return caught as AuthzConfigError;
};

const refuses = (roles: readonly unknown[], ...fragments: string[]): AuthzConfigError => {
  const err = refusesWith({}, roles);
  for (const f of fragments) expect(err.message).to.contain(f);
  return err;
};

// admin extends the non-assignable package admin.users; c extends b extends a (B12).
const B12_ROLES = [role('admin.users', ['users:read'], { assignable: false }), role('admin', ['user:impersonate'], { extends: ['admin.users'] }), role('a', ['doc:read']), role('b', ['doc:write'], { extends: ['a'] }), role('c', [], { extends: ['b'] })];

describe('authz-rbac model: compileRoles', () => {
  describe('extends closure', () => {
    it('a role extending another holds both in its closure, itself first', () => {
      const g = compileRoles(B12_ROLES);
      expect(g.get('admin')?.closure).to.deep.equal(['admin', 'admin.users']);
      expect(g.get('admin.users')?.closure).to.deep.equal(['admin.users']);
    });

    it('extends is transitive', () => {
      const g = compileRoles(B12_ROLES);
      expect(g.get('c')?.closure).to.deep.equal(['c', 'b', 'a']);
      expect(g.get('b')?.closure).to.deep.equal(['b', 'a']);
    });

    it('a diamond appears once per role, nearest roles first', () => {
      const g = compileRoles([role('top', [], { extends: ['left', 'right'] }), role('left', [], { extends: ['base'] }), role('right', [], { extends: ['base'] }), role('base')]);
      expect(g.get('top')?.closure).to.deep.equal(['top', 'left', 'right', 'base']);
    });

    it('closure order follows the order of extends, not the order of definitions', () => {
      const g = compileRoles([role('x'), role('y'), role('top', [], { extends: ['y', 'x'] })]);
      expect(g.get('top')?.closure).to.deep.equal(['top', 'y', 'x']);
    });

    it('a role that is not assignable still passes its grants on through extends', () => {
      const g = compileRoles(B12_ROLES);
      expect(g.get('admin.users')?.assignable).to.equal(false);
      expect(g.get('admin')?.assignable).to.equal(true);
      expect(g.get('admin')?.closure).to.include('admin.users');
    });

    it('keeps the definition, assignable and scopeTypes per role', () => {
      const def = role('org.admin', ['org:manage'], { scopeTypes: ['org'], description: 'org admins' });
      const g = compileRoles([def]);
      const r = g.get('org.admin');
      expect(r?.name).to.equal('org.admin');
      expect(r?.def).to.equal(def);
      expect(r?.assignable).to.equal(true);
      expect(r?.scopeTypes).to.deep.equal(['org']);
      expect(compileRoles([role('x')]).get('x')?.scopeTypes).to.equal(undefined);
    });

    it('lists the role names in definition order and answers has/get for unknown roles', () => {
      const g = compileRoles(B12_ROLES);
      expect(g.names).to.deep.equal(['admin.users', 'admin', 'a', 'b', 'c']);
      expect(g.has('a')).to.equal(true);
      expect(g.has('ghost')).to.equal(false);
      expect(g.get('ghost')).to.equal(undefined);
    });

    it('accepts an empty role list', () => {
      expect(compileRoles([]).names).to.deep.equal([]);
    });

    it('keeps the ladders it was given', () => {
      const ladders: LadderDef[] = [{ name: 'project', roles: ['viewer', 'editor'] }];
      const g = compileRoles([role('viewer', [], { ladder: 'project' }), role('editor', [], { ladder: 'project' })], ladders);
      expect(g.ladders).to.deep.equal(ladders);
      expect(compileRoles([]).ladders).to.deep.equal([]);
    });

    it('the graph is immutable', () => {
      const g = compileRoles(B12_ROLES);
      expect(Object.isFrozen(g)).to.equal(true);
      expect(Object.isFrozen(g.names)).to.equal(true);
      expect(Object.isFrozen(g.get('c'))).to.equal(true);
      expect(Object.isFrozen(g.get('c')?.closure)).to.equal(true);
    });

    it('deep chains compile and refuse without recursion limits', () => {
      const chain = (n: number) => Array.from({ length: n }, (_, i) => role(`r${i}`, [], { extends: i ? [`r${i - 1}`] : [] }));
      expect(compileRoles(chain(2000)).get('r1999')?.closure).to.have.length(2000);
      const n = 50000;
      const cycle = chain(n).map((r, i) => (i === 0 ? { ...r, extends: [`r${n - 1}`] } : r));
      expect(() => compileRoles(cycle)).to.throw(AuthzConfigError, /cycle/);
    });
  });

  describe('refusals (AuthzConfigError)', () => {
    it('a role that extends itself', () => {
      refuses([role('a', ['doc:read'], { extends: ['a'] })], "'a'", 'cycle');
    });

    it('a cycle of two roles names both', () => {
      refuses([role('a', ['doc:read'], { extends: ['b'] }), role('b', [], { extends: ['a'] })], "'a'", "'b'", 'cycle');
    });

    it('a longer cycle names every role on it, and not the roles off it', () => {
      const err = refuses([role('a', [], { extends: ['c'] }), role('b', [], { extends: ['a'] }), role('c', ['doc:read'], { extends: ['b'] }), role('d', [], { extends: ['a'] })], "'a'", "'b'", "'c'", 'cycle');
      expect(err.message).not.to.contain("'d'");
    });

    it('extends naming an unknown role names both roles', () => {
      refuses([role('a', ['doc:read'], { extends: ['ghost'] })], "'a'", "'ghost'");
    });

    it('two definitions with one name', () => {
      refuses([role('a', [], { source: 'config' }), role('a', [], { source: 'db' })], "'a'", 'twice', 'config', 'db');
    });

    it('a source that is not a string', () => {
      refuses([{ name: 'a', extends: [], grants: [], assignable: true }], "'a'", 'source');
      refuses([{ name: 'a', extends: [], grants: [], assignable: true, source: 7 }], "'a'", 'source');
    });

    it('a definition that is not an object', () => {
      refuses([null], 'role');
      refuses(['admin'], 'role');
    });

    it('a definition without a name', () => {
      refuses([{ extends: [], grants: [], assignable: true, source: 'test' }], 'name');
      refuses([{ name: '', extends: [], grants: [], assignable: true, source: 'test' }], 'name');
    });

    it('extends that is not an array of role names', () => {
      refuses([{ name: 'a', grants: [], assignable: true, source: 'test' }], "'a'", 'extends');
      refuses([{ name: 'a', extends: 'b', grants: [], assignable: true, source: 'test' }], "'a'", 'extends');
      refuses([{ name: 'a', extends: [1], grants: [], assignable: true, source: 'test' }], "'a'", 'extends');
    });

    it('grants that are not an array', () => {
      refuses([{ name: 'a', extends: [], assignable: true, source: 'test' }], "'a'", 'grants');
      refuses([{ name: 'a', extends: [], grants: {}, assignable: true, source: 'test' }], "'a'", 'grants');
    });

    it('assignable that is not a boolean', () => {
      refuses([{ name: 'a', extends: [], grants: [], assignable: 'yes', source: 'test' }], "'a'", 'assignable');
    });

    it('scopeTypes that are not a non-empty array of type names', () => {
      refuses([role('a', [], { scopeTypes: 'org' as unknown as string[] })], "'a'", 'scopeTypes');
      refuses([role('a', [], { scopeTypes: [] })], "'a'", 'scopeTypes');
      refuses([role('a', [], { scopeTypes: [''] })], "'a'", 'scopeTypes');
    });

    it('roles and ladders that are not arrays', () => {
      expect(() => compileRoles(undefined as unknown as RoleDef[])).to.throw(AuthzConfigError);
      expect(() => compileRoles([], {} as unknown as LadderDef[])).to.throw(AuthzConfigError);
    });
  });

  describe('extra edges (ladder seam)', () => {
    // A stand-in for L1b's ladder edges: each ladder role extends the role below it.
    const ladderEdges = (_defs: ReadonlyMap<string, RoleDef>, ladders: readonly LadderDef[]): RoleEdge[] => ladders.flatMap((l) => l.roles.slice(1).map((from, i) => ({ from, to: l.roles[i], via: `ladder '${l.name}'` })));
    const LADDER: LadderDef[] = [{ name: 'project', roles: ['viewer', 'editor', 'maintainer'] }];
    const ladderRoles = (extra: Extra = {}) => [role('viewer', ['file:read'], { ladder: 'project', ...extra }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', [], { ladder: 'project' })];

    it('joins the closure next to extends', () => {
      const g = compileRoles([...ladderRoles(), role('lead', [], { extends: ['maintainer'] })], LADDER, { extraEdges: ladderEdges });
      expect(g.get('maintainer')?.closure).to.deep.equal(['maintainer', 'editor', 'viewer']);
      expect(g.get('lead')?.closure).to.deep.equal(['lead', 'maintainer', 'editor', 'viewer']);
    });

    it('receives the definitions by name and the ladders', () => {
      let seen: [string[], readonly LadderDef[]] | undefined;
      compileRoles(ladderRoles(), LADDER, {
        extraEdges: (defs, ladders) => {
          seen = [[...defs.keys()], ladders];
          return [];
        },
      });
      expect(seen?.[0]).to.deep.equal(['viewer', 'editor', 'maintainer']);
      expect(seen?.[1]).to.deep.equal(LADDER);
    });

    it('a cycle through an extra edge and extends is refused, naming each kind of edge on it', () => {
      const err = refusesWith({ extraEdges: ladderEdges }, ladderRoles({ extends: ['maintainer'] }), LADDER);
      for (const f of ["'viewer'", "'editor'", "'maintainer'", 'cycle', 'extends', "ladder 'project'"]) expect(err.message).to.contain(f);
    });

    it('a cycle of extra edges alone is refused', () => {
      const back = (): RoleEdge[] => [
        { from: 'a', to: 'b', via: 'test' },
        { from: 'b', to: 'a', via: 'test' },
      ];
      const err = refusesWith({ extraEdges: back }, [role('a'), role('b')]);
      expect(err.message).to.contain("'a'").and.to.contain("'b'").and.to.contain('test');
    });

    it('an extra edge from or to an unknown role is refused, naming the role and the edge kind', () => {
      const from = refusesWith({ extraEdges: () => [{ from: 'ghost', to: 'a', via: "ladder 'x'" }] }, [role('a')]);
      expect(from.message).to.contain("'ghost'").and.to.contain("ladder 'x'");
      const to = refusesWith({ extraEdges: () => [{ from: 'a', to: 'ghost', via: "ladder 'x'" }] }, [role('a')]);
      expect(to.message).to.contain("'a'").and.to.contain("'ghost'").and.to.contain("ladder 'x'");
    });
  });

  describe('assignmentProblem', () => {
    const g = compileRoles([role('editor'), role('package', [], { assignable: false }), role('org.admin', [], { scopeTypes: ['org'] }), role('anywhere', [], { scopeTypes: ['org', '$global'] }), role('pkg.org', [], { assignable: false, scopeTypes: ['org'] })]);
    const O1 = { type: 'org', id: 'o1' };
    const P1 = { type: 'project', id: 'p1' };

    it('unknown_role for a role the graph does not hold', () => {
      expect(assignmentProblem(g, 'ghost', O1)).to.equal('unknown_role');
    });

    it('not_assignable for a role with assignable: false, before the scope type is judged', () => {
      expect(assignmentProblem(g, 'package', O1)).to.equal('not_assignable');
      expect(assignmentProblem(g, 'pkg.org', P1)).to.equal('not_assignable');
    });

    it('wrong_scope_type for a role with scopeTypes at another scope type (B13)', () => {
      expect(assignmentProblem(g, 'org.admin', P1)).to.equal('wrong_scope_type');
      expect(assignmentProblem(g, 'org.admin', O1)).to.equal(undefined);
    });

    it('a role with scopeTypes sits at $global only when it lists $global', () => {
      expect(assignmentProblem(g, 'org.admin', GLOBAL)).to.equal('wrong_scope_type');
      expect(assignmentProblem(g, 'anywhere', GLOBAL)).to.equal(undefined);
    });

    it('a role without scopeTypes may be assigned at any scope, $global included', () => {
      expect(assignmentProblem(g, 'editor', GLOBAL)).to.equal(undefined);
      expect(assignmentProblem(g, 'editor', P1)).to.equal(undefined);
      expect(assignmentProblem(g, 'editor', { type: 'file', id: 'f1' })).to.equal(undefined);
    });
  });

  describe('properties', () => {
    const reachable = (roles: readonly TestRoleDef[], from: string): Set<string> => {
      const byName = new Map(roles.map((r) => [r.name, r]));
      const seen = new Set<string>([from]);
      const todo = [from];
      while (todo.length) for (const next of byName.get(todo.pop()!)!.extends) if (!seen.has(next)) seen.add(next), todo.push(next);
      return seen;
    };

    it('the closure of every role equals the roles reachable by extends', () => {
      fc.assert(
        fc.property(arb.roleGraph({ roles: 8, maxExtends: 3 }), (roles) => {
          const g = compileRoles(roles);
          for (const r of roles) {
            const closure = g.get(r.name)!.closure;
            expect(closure[0]).to.equal(r.name);
            expect(new Set(closure).size).to.equal(closure.length);
            expect(new Set(closure)).to.deep.equal(reachable(roles, r.name));
          }
        }),
      );
    });

    it('the order of definitions does not change any closure', () => {
      fc.assert(
        fc.property(
          arb.roleGraph({ roles: 6 }).chain((roles) => fc.tuple(fc.constant(roles), fc.shuffledSubarray(roles, { minLength: roles.length, maxLength: roles.length }))),
          ([roles, shuffled]) => {
            const a = compileRoles(roles);
            const b = compileRoles(shuffled);
            for (const r of roles) expect(b.get(r.name)!.closure).to.deep.equal(a.get(r.name)!.closure);
          },
        ),
      );
    });

    it('an edge back to a role that reaches the extending role is refused', () => {
      fc.assert(
        fc.property(arb.roleGraph({ roles: 6, maxExtends: 2 }), fc.nat(), fc.nat(), (roles, i, j) => {
          const g = compileRoles(roles);
          const from = roles[i % roles.length];
          const ancestors = g.get(from.name)!.closure;
          const target = ancestors[j % ancestors.length];
          // from ⇝ target already holds, so target → from closes a cycle (or from → from when they coincide).
          const cyclic = roles.map((r) => (r.name === target ? { ...r, extends: [...r.extends.filter((e) => e !== from.name), from.name] } : r));
          expect(() => compileRoles(cyclic)).to.throw(AuthzConfigError, /cycle/);
        }),
      );
    });
  });

  describe('kit structural copies (F5)', () => {
    it('the kit role-graph types are assignable to the authz-rbac contracts', () => {
      const g: TestGrantDef = { permission: 'file:read' };
      const i: TestImpliedRole = { role: 'viewer', at: 'descendants' };
      const r: TestRoleDef = { name: 'a', extends: [], grants: [g], implies: [i], assignable: true, source: 'test' };
      const l: TestLadderDef = { name: 'project', roles: ['a'] };
      const grant: GrantDef = g;
      const implied: ImpliedRole = i;
      const def: RoleDef = r;
      const ladder: LadderDef = l;
      const graph: RoleGraph = compileRoles([def], [ladder]);
      expect([grant, implied, graph.names]).to.have.length(3);
    });
  });
});
