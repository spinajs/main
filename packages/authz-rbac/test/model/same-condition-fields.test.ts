import { Authorizer, CORE_FILTER_OPS, DefaultConditionCompiler, GLOBAL, PermissionRegistryImpl, and, compileFieldGlobs, not, or } from '@spinajs/authz';
import type { Assignment, ResourceFilter, ResourceRef } from '@spinajs/authz';
import { FakeAdapter, evaluateFilter, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RBAC_STEPS, RbacModel, compileGrants, compileRoles, runRbacPipeline } from '../../src/index.js';
import type { RbacSteps, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice = userPrincipal('alice');
const U1: ResourceRef = { type: 'user', id: 'u1' };

const GUEST: RoleDef = { name: 'guest', extends: [], assignable: true, source: 'test', grants: [{ permission: 'user:read', relation: 'self', fields: { read: ['Login'] } }] };
const USER: RoleDef = { name: 'user', extends: [], assignable: true, source: 'test', grants: [{ permission: 'user:read', relation: 'self', fields: { read: ['Email', 'Login'] } }] };

describe('authz-rbac: conditional grants with the same condition unite their fields (RFC C3-1)', () => {
  it("guest plus user: AuthzService's check and summary entry read Email and Login", async () => {
    const registry = new PermissionRegistryImpl();
    registry.register([{ name: 'user:read', types: ['user'], fields: true }], 'test');
    registry.freeze();
    const assignments: Assignment[] = ['guest', 'user'].map((role, i) => ({ id: `a${i}`, subject: { type: 'user', id: 'alice' }, role, scope: GLOBAL, source: 'test' }));
    const model = new RbacModel({ roles: new MemoryRoleStore([GUEST, USER], []), assignments: new MemoryAssignmentStore(assignments), log: { warn: () => undefined } });
    await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
    const adapter = new FakeAdapter({ types: ['user'], rows: { user: [{ id: 'alice' }] }, compiles: [...CORE_FILTER_OPS] });
    const authz = new Authorizer({ domain: 'root', models: [model], registry, adapters: [adapter], conditions: new DefaultConditionCompiler(), log: { error: () => undefined, warn: () => undefined, debug: () => undefined } });

    const check = await authz.check({ principal: alice, permission: 'user:read', resource: { type: 'user', id: 'alice' } });
    expect(check.allowed).to.equal(true);
    expect(check.fields.read).to.have.members(['Email', 'Login']);
    const entry = (await authz.summary(alice)).permissions.find((p) => p.name === 'user:read');
    expect(entry?.conditional).to.equal(true);
    expect(entry?.fields?.read).to.have.members(['Email', 'Login']);
  });

  describe('property: the union applies only to grants whose conditions are the same', () => {
    const FIELDS = ['f0', 'f1', 'f2', 'f3'];
    // A field no grant names: only a grant without fields gives it.
    const UNIVERSE = [...FIELDS, 'other'];
    const A: ResourceFilter = { op: 'cmp', field: 'a', cmp: 'eq', value: 1 };
    const B: ResourceFilter = { op: 'cmp', field: 'b', cmp: 'eq', value: 1 };
    const C: ResourceFilter = { op: 'cmp', field: 'c', cmp: 'eq', value: 1 };
    // Pairwise different after simplification, so "the same condition" is "the same pool index".
    const POOL: readonly ResourceFilter[] = [A, B, and(A, B), or(A, C), not(B)];
    const ROWS = [0, 1].flatMap((a) => [0, 1].flatMap((b) => [0, 1].map((c) => ({ id: `r${a}${b}${c}`, a, b, c }))));

    interface Grant {
      readonly cond: number;
      /** Undefined: the grant carries no fields (every field). */
      readonly read: readonly string[] | undefined;
      /** The grant's condition is a structured clone of the pool's, not the pool's own node. */
      readonly clone: boolean;
    }

    const grantArb: fc.Arbitrary<Grant> = fc.record({
      cond: fc.integer({ min: 0, max: POOL.length - 1 }),
      read: fc.option(fc.subarray(FIELDS), { nil: undefined, freq: 5 }),
      clone: fc.boolean(),
    });

    function vote(grants: readonly Grant[]) {
      const registry = new PermissionRegistryImpl();
      registry.register([{ name: 'user:read', fields: true }], 'test');
      registry.freeze();
      const roles = compileRoles(grants.map((g, i): RoleDef => ({ name: `r${i}`, extends: [], assignable: true, source: 'test', grants: [{ permission: 'user:read', ...(g.read ? { fields: { read: [...g.read] } } : {}) }] })));
      // The conditions enter as the rows of the grants' checks (steps 6–7), so they reach residual like any check.
      const steps: RbacSteps = {
        ...RBAC_STEPS,
        tag: (s) => {
          for (const c of s.candidates) {
            const g = grants[Number(c.grant.role.slice(1))];
            c.rows = g.clone ? structuredClone(POOL[g.cond]) : POOL[g.cond];
          }
        },
      };
      return runRbacPipeline(
        {
          request: { principal: alice, permission: 'user:read', resource: U1 },
          now: NOW,
          path: [U1, GLOBAL],
          assignments: grants.map((_, i): Assignment => ({ id: `a${i}`, subject: { type: 'user', id: 'alice' }, role: `r${i}`, scope: GLOBAL, source: 'test' })),
          roles,
          grants: compileGrants(roles, registry),
        },
        steps,
      );
    }

    const given = (g: Grant): Set<string> => new Set(g.read ?? UNIVERSE);
    const intersect = (sets: readonly Set<string>[]) => new Set(UNIVERSE.filter((f) => sets.every((s) => s.has(f))));
    const unite = (sets: readonly Set<string>[]) => new Set(UNIVERSE.filter((f) => sets.some((s) => s.has(f))));
    const sorted = (s: Set<string>) => [...s].sort();

    it('every field the vote gives on a row it permits is given by a grant whose condition holds on that row', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(grantArb, { minLength: 1, maxLength: 6 }), async (grants) => {
          const v = vote(grants);
          const globs = compileFieldGlobs(v.fields?.read ?? ['*']);
          const read = new Set(UNIVERSE.filter((f) => globs.allows(f)));
          const env = { principal: alice, ref: U1 };
          for (const row of ROWS) {
            if ((await evaluateFilter(v.permitWhen, row, env)) !== true) continue;
            const onRow: Grant[] = [];
            for (const g of grants) if ((await evaluateFilter(POOL[g.cond], row, env)) === true) onRow.push(g);
            for (const f of read)
              expect(
                onRow.some((g) => given(g).has(f)),
                `${row.id}: ${f} from ${JSON.stringify(grants)}`,
              ).to.equal(true);
          }
        }),
        { numRuns: 300 },
      );
    });

    it('the fields are the intersection over groups of the same condition of the union within each group', () => {
      fc.assert(
        fc.property(fc.array(grantArb, { minLength: 1, maxLength: 6 }), (grants) => {
          const v = vote(grants);
          const globs = compileFieldGlobs(v.fields?.read ?? ['*']);
          const read = new Set(UNIVERSE.filter((f) => globs.allows(f)));
          const groups = new Map<number, Set<string>[]>();
          for (const g of grants) groups.set(g.cond, [...(groups.get(g.cond) ?? []), given(g)]);
          const expected = intersect([...groups.values()].map(unite));
          const plain = intersect(grants.map(given));
          const all = unite(grants.map(given));
          expect(sorted(read), JSON.stringify(grants)).to.deep.equal(sorted(expected));
          for (const f of plain) expect(read.has(f), `${f} of the plain intersection`).to.equal(true);
          for (const f of read) expect(all.has(f), `${f} within the full union`).to.equal(true);
          if (groups.size === grants.length) expect(sorted(read)).to.deep.equal(sorted(plain));
        }),
        { numRuns: 300 },
      );
    });
  });
});
