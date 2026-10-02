import * as fc from 'fast-check';

import { CORE_FILTER_OPS, GLOBAL } from '@spinajs/authz';
import type { ResourceFilter, Value, Vote } from '@spinajs/authz';

import { row, vote } from '../arbitraries/index.js';
import { FAKE_TUPLE_OP } from '../fakes/index.js';
import type { ScriptedVote } from '../fakes/index.js';
import { userPrincipal } from '../principals.js';
import { ALGORITHMS, assignment, cmp, combine, fixture, permit, ref, relation, role, staticModel } from './dsl.js';
import type { Case, World } from './types.js';

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const OWNER = { type: 'file', relation: 'owner', column: 'owner' };

const files = [
  { id: 'f1', owner: 'alice' },
  { id: 'f2', owner: 'bob' },
  { id: 'f3', owner: 'carol' },
];

const fileAdapter = (compiles = CORE_FILTER_OPS) => ({
  types: ['file'],
  rows: { file: files },
  parents: [[ref('file', 'f1'), P1] as const, [ref('file', 'f2'), P2] as const, [ref('file', 'f3'), P2] as const],
  relations: [OWNER],
  compiles,
});

const ownerWorld: World = {
  permissions: ['file:read'],
  principals: { alice, bob, carol },
  adapters: [fileAdapter()],
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { 'file:read': permit(relation('owner')) } })],
};

const fakeRbacWorld: World = {
  permissions: ['file:read', 'file:write'],
  principals: { alice, bob, carol },
  adapters: [fileAdapter()],
  combine: combine('deny-overrides', 'rbac'),
  models: [
    {
      kind: 'fake-rbac',
      roles: { viewer: ['file:read'], owner: [{ permission: 'file:*', relation: 'owner' }] },
      assignments: [
        { subject: alice, role: 'viewer', scope: P1 },
        { subject: bob, role: 'owner' },
      ],
    },
  ],
};

const fakeTupleWorld: World = {
  permissions: ['file:read'],
  principals: { alice, bob, carol },
  adapters: [fileAdapter([...CORE_FILTER_OPS, FAKE_TUPLE_OP])],
  combine: combine('deny-overrides', 'rebac'),
  models: [
    {
      kind: 'fake-tuple',
      schema: { file: { relations: { viewer: 'user', parent: 'folder' }, permissions: { view: 'viewer | parent->view' } }, folder: { relations: { viewer: 'user' }, permissions: { view: 'viewer' } } },
      permissions: { 'file:read': 'file#view' },
      tuples: [
        { object: ref('file', 'f1'), relation: 'viewer', subject: alice },
        { object: ref('file', 'f2'), relation: 'parent', subject: { type: 'folder', id: 'd1' } },
        { object: ref('folder', 'd1'), relation: 'viewer', subject: bob },
      ],
    },
  ],
};

// Generated worlds: two scripted models whose votes come from the kit's vote arbitrary (fixed seed),
// over generated rows under p1/p2, so the same data runs everywhere. Each column holds one value type
// (SQL columns are typed): `n` numbers, the others strings; owner values are principal ids.
const STRING_FIELDS = ['name', 'status', 'owner'];
const STRINGS = ['a', 'b', 'c'];
const NUMBERS = [1, 2, 3];
const genVote = (model: string) => vote({ model, fields: [...STRING_FIELDS, 'n'], values: [...STRINGS, ...NUMBERS], relations: ['owner'], scopes: [P1, P2, GLOBAL], refs: ['principal.id', 'principal.attributes.pool'], depth: 2 });
const genRow = fc.tuple(row({ fields: STRING_FIELDS, values: STRINGS }), row({ fields: ['n'], values: NUMBERS })).map(([s, n]) => ({ ...s, ...n }));

const PATTERNS = new Set(['like', 'glob', 'wildcard']);
const asNumber = (v: unknown): unknown => (typeof v === 'number' || v === null ? v : NUMBERS[STRINGS.indexOf(String(v))] ?? NUMBERS[0]);
const asString = (v: unknown): unknown => (typeof v === 'string' || v === null || (typeof v === 'object' && v !== null && 'ref' in v) ? v : STRINGS[NUMBERS.indexOf(v as number)] ?? STRINGS[0]);

/** The filter with every comparison value of the type of its column; a pattern on `n` moves to `name`. */
function typed(f: ResourceFilter): ResourceFilter {
  switch (f.op) {
    case 'and':
    case 'or':
      return { ...f, args: f.args.map(typed) };
    case 'not':
      return { ...f, arg: typed(f.arg) };
    case 'cmp': {
      if (f.field !== 'n') return f.value === undefined ? f : { ...f, value: (Array.isArray(f.value) ? f.value.map(asString) : asString(f.value)) as Value };
      if (PATTERNS.has(f.cmp)) return { ...f, field: 'name' };
      return f.value === undefined ? f : { ...f, value: (Array.isArray(f.value) ? f.value.map(asNumber) : asNumber(f.value)) as Value };
    }
    default:
      return f;
  }
}

const scripted = (v: Vote): ScriptedVote => ({ permitWhen: typed(v.permitWhen), denyWhen: typed(v.denyWhen), cacheable: v.cacheable, ...(v.denies ? { denies: v.denies.map((d) => ({ ...d, when: typed(d.when) })) } : {}), ...(v.error !== undefined ? { error: v.error } : {}), ...(v.reason ? { reason: v.reason } : {}) });

let generatedWorlds: readonly { readonly name: string; readonly world: World }[] | undefined;

// Sampled on first use, so importing the kit does not run fast-check.
const generated = () =>
  (generatedWorlds ??= fc.sample(fc.tuple(fc.array(genRow, { minLength: 4, maxLength: 8 }), genVote('m1'), genVote('m2')), { seed: 20261001, numRuns: 9 }).map(([rows, v1, v2], i) => {
    const algorithm = ALGORITHMS[i % ALGORITHMS.length];
    const named = rows.map((r, j) => ({ ...r, id: `r${j}` }));
    return {
      name: `generated world ${i} (${algorithm})`,
      world: {
        permissions: ['file:read'],
        principals: { gen: userPrincipal('a', { attributes: { pool: 'b' } }) },
        adapters: [{ types: ['file'], rows: { file: named }, parents: named.map((r, j) => [ref('file', r.id), j % 2 ? P2 : P1] as const), relations: [OWNER] }],
        combine: combine(algorithm, 'm1', 'm2'),
        models: [staticModel('m1', { votes: { 'file:read': scripted(v1) } }), staticModel('m2', { votes: { 'file:read': scripted(v2) } })],
      },
    };
  }));

const agreeCases = (who: readonly string[]): Case[] => [{ name: 'kit StaticModel with a relation residual: check ⇔ filter', world: ownerWorld, steps: [{ agree: { as: who, permissions: ['file:read'], type: 'file' } }] }, { name: 'kit FakeRbacModel (scoped and relation grants): check ⇔ filter', world: fakeRbacWorld, steps: [{ agree: { as: who, permissions: ['file:read', 'file:write'], type: 'file' } }] }, { name: 'kit FakeTupleModel (native:fake.tuple): check ⇔ filter', world: fakeTupleWorld, steps: [{ agree: { as: who, permissions: ['file:read'], type: 'file' } }] }, ...generated().map((g): Case => ({ name: `${g.name}: check ⇔ filter`, world: g.world, steps: [{ agree: { as: ['gen'], permissions: ['file:read'], type: 'file' } }] }))];

const threeValued: World = {
  permissions: ['file:read'],
  principals: { alice },
  adapters: [
    {
      types: ['file'],
      rows: {
        file: [
          { id: 'r1', status: 'open' },
          { id: 'r2', status: 'locked' },
          { id: 'r3', status: null },
        ],
      },
    },
  ],
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { 'file:read': permit(cmp('status', 'ne', 'locked')) } })],
};

const inMemory = (): Case[] => [
  {
    name: 'a comparison with a NULL cell is UNKNOWN, which does not allow (SQL three-valued logic)',
    world: threeValued,
    steps: [{ check: { as: 'alice', permission: 'file:read', resource: ref('file', 'r3'), subject: 'row' }, expect: { allowed: false, residual: 'FALSE' } }, { filter: { as: 'alice', permission: 'file:read', type: 'file' }, expect: { selects: ['r1'] } }, { agree: { as: ['alice'], permissions: ['file:read'], type: 'file' } }],
  },
  {
    name: 'without a subject a conditional permit is allowed with a non-TRUE residual',
    world: ownerWorld,
    steps: [
      { check: { as: 'alice', permission: 'file:read' }, expect: { allowed: true, residual: 'conditional' } },
      { check: { as: 'alice', permission: 'file:read', resource: ref('file', 'f2') }, expect: { allowed: true, residual: 'conditional' } },
    ],
  },
  {
    name: 'with a subject the residual is evaluated and the answer is definite',
    world: ownerWorld,
    steps: [
      { check: { as: 'alice', permission: 'file:read', resource: ref('file', 'f1'), subject: 'row' }, expect: { allowed: true, residual: 'TRUE' } },
      { check: { as: 'alice', permission: 'file:read', resource: ref('file', 'f2'), subject: 'row' }, expect: { allowed: false, residual: 'FALSE' } },
    ],
  },
  ...agreeCases(['alice', 'bob', 'carol']),
];

const rbacWorld: World = {
  permissions: ['file:read'],
  principals: { alice, bob, carol },
  adapters: [fileAdapter()],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('viewer', ['file:read']), role('owner', [{ permission: 'file:read', relation: 'owner' }])],
    assignments: [assignment('a1', alice, 'viewer', P1), assignment('a2', bob, 'owner')],
  },
};

let coreCases: readonly Case[] | undefined;
let sqlCases: readonly Case[] | undefined;

export const B06 = fixture('B06', [
  {
    name: 'core',
    facets: ['engine'],
    lanes: ['F3'],
    note: "The in-memory part (plan F3: 'B06 (in-memory)'). The filter side is the kit's evaluateFilter over the world rows (or session.list when the harness has one). A residual is evaluated against a subject with SQL three-valued logic: NULL or a type mismatch is UNKNOWN, which does not allow.",
    get cases() {
      return (coreCases ??= inMemory());
    },
  },
  {
    name: 'rbac',
    facets: ['engine', 'rbac', 'list'],
    lanes: ['L1'],
    note: "Type-level RBAC residuals carry native:rbac.assignment, which only the lane can evaluate: the harness's list runs the residual with the model's NativeFilter.",
    world: rbacWorld,
    cases: [
      {
        name: 'scoped and relation grants: definite answers with a subject',
        steps: [
          { check: { as: 'alice', permission: 'file:read', resource: ref('file', 'f1'), subject: 'row' }, expect: { allowed: true } },
          { check: { as: 'alice', permission: 'file:read', resource: ref('file', 'f2'), subject: 'row' }, expect: { allowed: false } },
          { check: { as: 'bob', permission: 'file:read', resource: ref('file', 'f2'), subject: 'row' }, expect: { allowed: true } },
          { check: { as: 'bob', permission: 'file:read', resource: ref('file', 'f3'), subject: 'row' }, expect: { allowed: false } },
        ],
      },
      { name: 'scoped and relation grants: check ⇔ filter', steps: [{ agree: { as: ['alice', 'bob', 'carol'], permissions: ['file:read'], type: 'file' } }] },
    ],
  },
  {
    name: 'sql',
    facets: ['engine', 'list', 'sql'],
    lanes: ['L4'],
    note: 'The agree worlds of B06.core with the rows in SQLite and Postgres (one value type per column); native:fake.tuple goes through a test compiler (plan L4 task 10).',
    get cases() {
      return (sqlCases ??= [{ name: 'a NULL cell is UNKNOWN in SQL too: check ⇔ filter', world: threeValued, steps: [{ agree: { as: ['alice'], permissions: ['file:read'], type: 'file' } }] }, ...agreeCases(['alice', 'bob', 'carol'])]);
    },
  },
  { name: 'rules', facets: ['engine', 'rbac', 'rules', 'list'], lanes: ['L1b'], note: 'Worlds with RBAC rules on the type come with the rule fixtures of B35, or from L1b by RFC.', cases: [] },
  { name: 'rulesSql', facets: ['engine', 'rbac', 'rules', 'list', 'sql'], lanes: ['L4b', 'K1'], note: 'The rule worlds in SQL; with B44, or from L4b by RFC.', cases: [] },
]);
