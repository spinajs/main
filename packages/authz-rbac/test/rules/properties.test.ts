import { DefaultConditionCompiler, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, EvaluationContext, NativeFilter, PermissionInput, Principal, ResourceFilter, ResourceRef, RuleDef, Vote } from '@spinajs/authz';
import { FakeScopeResolver, evaluateFilter, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { ConfigRuleStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel, createRbacExtensions, rbacAssignmentExtension } from '../../src/index.js';
import type { LadderDef, RoleDef } from '../../src/index.js';

const expect = chai.expect;

/*
 * Properties of the RBAC rules and ladders (plan L1b task 10) over random worlds: a project ladder
 * whose roles grant random permissions, an off-ladder role, assignments at every level, and rules
 * from a pool of restrict, cap and threshold rules, conditions on org attributes included.
 */

const NOW = new Date('2026-10-01T12:00:00.000Z');
const r = (type: string, id: string): ResourceRef => ({ type, id });
const [O1, O2, P1, P2, P3] = [r('org', 'o1'), r('org', 'o2'), r('project', 'p1'), r('project', 'p2'), r('project', 'p3')];
const FILES = [
  { ref: r('file', 'f1'), parent: P1, name: 'notes' },
  { ref: r('file', 'f2'), parent: P1, name: 'release/1' },
  { ref: r('file', 'f3'), parent: P2, name: 'plan' },
  { ref: r('file', 'f4'), parent: P3, name: 'release/2' },
];
const FILE = { type: 'file' };
const PERMS = ['file:read', 'file:comment', 'file:edit', 'file:admin', 'file:share'];
const LADDER = ['viewer', 'commenter', 'editor', 'maintainer'];
const ROLE_NAMES = [...LADDER, 'guest'];
const SCOPES: ResourceRef[] = [GLOBAL, O1, O2, P1, P2, P3, ...FILES.map((f) => f.ref)];
const PEOPLE = ['alice', 'bob'];

const RULES: Omit<RuleDef, 'source'>[] = [
  { id: 'c-global', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'commenter' },
  { id: 'c-o1-viewer', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer' },
  { id: 'c-p2-drop', kind: 'cap', scope: P2, ladder: 'project', maxRole: null },
  { id: 'c-locked', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: { attr: 'scope.org.policies.locked', eq: true } },
  { id: 'c-bob', kind: 'cap', scope: O2, ladder: 'project', maxRole: 'viewer', subjects: { refs: [{ type: 'user', id: 'bob' }] } },
  { id: 'r-p1', kind: 'restrict', scope: P1, allow: [] },
  { id: 'r-o2-bob', kind: 'restrict', scope: O2, allow: [{ type: 'user', id: 'bob' }] },
  { id: 'r-f3', kind: 'restrict', scope: FILES[2].ref, allow: [{ type: 'user', id: 'alice' }] },
  { id: 'r-open', kind: 'restrict', scope: P3, allow: [], when: { attr: 'scope.org.policies.open', eq: false } },
  { id: 't-edit', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit'], minRole: 'maintainer' },
  { id: 't-release', kind: 'threshold', scope: O1, permissions: ['file:*'], minRole: 'editor', resource: { attr: 'resource.name', wildcard: 'release/*' } },
];
const NARROWING = RULES.filter((x) => x.kind !== 'threshold');

interface World {
  readonly grants: readonly (readonly string[])[];
  readonly guest: readonly string[];
  readonly assignments: readonly { readonly who: number; readonly role: number; readonly scope: number }[];
  readonly rules: readonly number[];
  readonly locked: readonly [boolean, boolean];
}

const worlds: fc.Arbitrary<World> = fc.record({
  grants: fc.array(fc.subarray(PERMS, { maxLength: 3 }), { minLength: LADDER.length, maxLength: LADDER.length }),
  guest: fc.subarray(PERMS, { maxLength: 2 }),
  assignments: fc.array(fc.record({ who: fc.nat({ max: PEOPLE.length - 1 }), role: fc.nat({ max: ROLE_NAMES.length - 1 }), scope: fc.nat({ max: SCOPES.length - 1 }) }), { minLength: 1, maxLength: 5 }),
  rules: fc.subarray([...RULES.keys()], { maxLength: 4 }),
  locked: fc.tuple(fc.boolean(), fc.boolean()),
});

/** A deterministic shuffle of `items` (or the identity for seed 0). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  if (seed === 0) return [...items];
  let s = seed;
  return items
    .map((item) => {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      return [s >>> 8, item] as const;
    })
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);
}

const role = (name: string, permissions: readonly string[], ladder?: string): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...(ladder ? { ladder } : {}), grants: permissions.map((permission) => ({ permission })) });

function registry() {
  const reg = new PermissionRegistryImpl();
  reg.register(
    PERMS.map((name): PermissionInput => ({ name, types: ['org', 'project', 'file'] })),
    'test',
  );
  reg.freeze();
  return reg;
}

interface Built {
  readonly model: RbacModel;
  ctx(): EvaluationContext;
}

/** The model of `w`, plus `extra` rules; `order` shuffles rules, assignments, roles and grants. */
async function build(w: World, opts: { readonly extra?: readonly Omit<RuleDef, 'source'>[]; readonly order?: number } = {}): Promise<Built> {
  const order = opts.order ?? 0;
  const roles = [...LADDER.map((name, i) => role(name, shuffled(w.grants[i], order), 'project')), role('guest', shuffled(w.guest, order))];
  const ladders: LadderDef[] = [{ name: 'project', roles: LADDER }];
  const rows = w.assignments.map((a, i): Assignment => ({ id: `a${i}`, subject: { type: 'user', id: PEOPLE[a.who] }, role: ROLE_NAMES[a.role], scope: SCOPES[a.scope], source: 'test' }));
  const rules = [...w.rules.map((i) => RULES[i]), ...(opts.extra ?? [])].map((x): RuleDef => ({ ...x, source: 'test' }));
  const base = { roles: new MemoryRoleStore(shuffled(roles, order), ladders), assignments: new MemoryAssignmentStore(shuffled(rows, order)), rules: new ConfigRuleStore(shuffled(rules, order)) };
  const model = new RbacModel({ ...base, extensions: [...createRbacExtensions(base), rbacAssignmentExtension(base, { rules: true })], log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
  const scopes = new FakeScopeResolver({
    types: ['org', 'project', 'file'],
    nodes: [{ ref: O1, attributes: { policies: { locked: w.locked[0], open: true } } }, { ref: O2, attributes: { policies: { locked: w.locked[1], open: false } } }, { ref: P1, parent: O1 }, { ref: P2, parent: O1 }, { ref: P3, parent: O2 }, ...FILES.map((f) => ({ ref: f.ref, parent: f.parent }))],
  });
  const natives = model.extensions.flatMap((e) => e.nativeFilters?.() ?? []) as NativeFilter[];
  return { model, ctx: () => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes], conditions: new DefaultConditionCompiler(undefined, [scopes]), nativeFilters: natives }) };
}

const vote = (b: Built, principal: Principal, permission: string, resource: ResourceRef, c = b.ctx()): Promise<Vote> => Promise.resolve(b.model.evaluate({ principal, permission, resource }, c));
const decided = (v: Vote): ResourceFilter => ({ op: 'and', args: [v.permitWhen, { op: 'not', arg: v.denyWhen }] });
const holds = (f: ResourceFilter, row: (typeof FILES)[number], principal: Principal, c: EvaluationContext) => evaluateFilter(f, { id: row.ref.id, name: row.name }, { principal, ref: row.ref, context: c }).then((t) => t === true);

/** Whether the check of `permission` on `row` allows; a model error denies. */
async function checks(b: Built, principal: Principal, permission: string, row: (typeof FILES)[number]): Promise<boolean> {
  const c = b.ctx();
  return vote(b, principal, permission, row.ref, c).then(
    (v) => holds(decided(v), row, principal, c),
    () => false,
  );
}

/** The rows the type-level filter of `permission` selects; a model error selects none. */
async function lists(b: Built, principal: Principal, permission: string): Promise<string[]> {
  const c = b.ctx();
  let filter: ResourceFilter;
  try {
    filter = decided(await vote(b, principal, permission, FILE, c));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const row of FILES) if (await holds(filter, row, principal, c)) out.push(row.ref.id!);
  return out;
}

const principals = PEOPLE.map((id) => userPrincipal(id));
const RUNS = { numRuns: 100, seed: 20261005 };

describe('authz-rbac properties: rules and ladders', function () {
  this.timeout(300_000);

  it('adding a cap or a restrict never widens a check or a list', async () => {
    // Guards against a vacuous run: some checks and some list rows must be allowed before the rule.
    let allowed = 0;
    let narrowed = 0;
    await fc.assert(
      fc.asyncProperty(worlds, fc.constantFrom(...NARROWING), async (w, rule) => {
        const before = await build(w);
        const after = await build(w, { extra: [{ ...rule, id: `extra-${rule.id}` }] });
        for (const p of principals) {
          for (const permission of PERMS) {
            for (const row of FILES) {
              const was = await checks(before, p, permission, row);
              const is = await checks(after, p, permission, row);
              if (is) expect(was, `${p.id} ${permission} ${row.ref.id}`).to.equal(true);
              allowed += was ? 1 : 0;
              narrowed += was && !is ? 1 : 0;
            }
            const listed = new Set(await lists(before, p, permission));
            expect(
              (await lists(after, p, permission)).filter((id) => !listed.has(id)),
              `${p.id} ${permission} list`,
            ).to.deep.equal([]);
          }
        }
      }),
      RUNS,
    );
    expect([allowed > 0, narrowed > 0]).to.deep.equal([true, true]);
  });

  it('the effective ladder role gives the union of the grants of the held roles and every role below them', async () => {
    await fc.assert(
      fc.asyncProperty(worlds, async (w) => {
        const world: World = { ...w, rules: [], assignments: w.assignments.map((a) => ({ ...a, scope: 0 })) };
        const b = await build(world);
        for (const [who, p] of principals.entries()) {
          const held = world.assignments.filter((a) => a.who === who).map((a) => ROLE_NAMES[a.role]);
          const top = Math.max(-1, ...held.map((h) => LADDER.indexOf(h)));
          const expected = new Set([...world.grants.slice(0, top + 1).flat(), ...(held.includes('guest') ? world.guest : [])]);
          for (const permission of PERMS) expect(await checks(b, p, permission, FILES[0]), `${p.id} ${permission}`).to.equal(expected.has(permission));
        }
      }),
      RUNS,
    );
  });

  it('the decision and the reported reason do not depend on rule, assignment, role or grant order', async () => {
    await fc.assert(
      fc.asyncProperty(worlds, fc.integer({ min: 1, max: 0x7fffffff }), async (w, order) => {
        const a = await build(w);
        const b = await build(w, { order });
        const answer = async (m: Built, p: Principal, permission: string, row: (typeof FILES)[number]) => {
          const c = m.ctx();
          try {
            const v = await vote(m, p, permission, row.ref, c);
            return JSON.stringify([await holds(decided(v), row, p, c), v.reason ?? null]);
          } catch (e) {
            return JSON.stringify(['error', (e as Error).message]);
          }
        };
        for (const p of principals) for (const permission of PERMS) for (const row of FILES) expect(await answer(b, p, permission, row), `${p.id} ${permission} ${row.ref.id}`).to.equal(await answer(a, p, permission, row));
      }),
      RUNS,
    );
  });

  it('a vote after preload equals a fresh vote, on checks and on lists', async () => {
    await fc.assert(
      fc.asyncProperty(worlds, async (w) => {
        const warm = await build(w);
        const fresh = await build(w);
        for (const p of principals) {
          const c = warm.ctx();
          await warm.model.preload(p, c);
          for (const permission of PERMS) {
            for (const resource of [FILE, ...FILES.map((f) => f.ref)]) {
              const one = await vote(warm, p, permission, resource, c).then(JSON.stringify, (e: Error) => `error ${e.message}`);
              const two = await vote(fresh, p, permission, resource).then(JSON.stringify, (e: Error) => `error ${e.message}`);
              expect(one, `${p.id} ${permission} ${JSON.stringify(resource)}`).to.equal(two);
            }
          }
        }
      }),
      RUNS,
    );
  });

  it('summarize agrees with the checks: a permission it lists as unconditional is allowed, one a check allows is listed', async () => {
    await fc.assert(
      fc.asyncProperty(worlds, async (w) => {
        const b = await build(w);
        for (const p of principals) {
          for (const row of FILES) {
            let summary;
            try {
              summary = await b.model.summarize(p, row.ref, b.ctx());
            } catch {
              // A rule the check of this row cannot decide (B39) fails both.
              for (const permission of PERMS) expect(await checks(b, p, permission, row), `${p.id} ${permission} ${row.ref.id} (summarize failed)`).to.equal(false);
              continue;
            }
            const listed = new Map(summary.permissions.map((x) => [x.name, x.conditional]));
            for (const permission of PERMS) {
              const allowed = await checks(b, p, permission, row);
              if (listed.get(permission) === false) expect(allowed, `${p.id} ${permission} ${row.ref.id} listed unconditional`).to.equal(true);
              if (allowed) expect(listed.has(permission), `${p.id} ${permission} ${row.ref.id} allowed`).to.equal(true);
            }
          }
        }
      }),
      RUNS,
    );
  });
});
