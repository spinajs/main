import * as chai from 'chai';
import * as fc from 'fast-check';
import 'mocha';
import { GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import { GLOBAL_OBJECT, IREvaluator, MemoryTupleSource, mergeFragments, validateIR } from '@spinajs/authz-ir';
import type { EvalInput, IRFragment, Truth } from '@spinajs/authz-ir';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, irAgreement, userPrincipal, voteTruth, withCeiling } from '@spinajs/authz-testing';
import type { AgreementWorld } from '@spinajs/authz-testing';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel, compileGrants, compileRoles, rbacToIR } from '../src/index.js';
import type { Assignment, RoleDef } from '../src/index.js';

const expect = chai.expect;

interface Node {
  readonly type: string;
  readonly id: string;
}

const NOW = new Date('2026-11-16T12:00:00.000Z');
const O1: Node = { type: 'org', id: 'o1' };
const O2: Node = { type: 'org', id: 'o2' };
const P1: Node = { type: 'project', id: 'p1' };
const P2: Node = { type: 'project', id: 'p2' };
const D1: Node = { type: 'doc', id: 'd1' };
const D2: Node = { type: 'doc', id: 'd2' };
/** child, parent: d1 in p1 in o1, d2 in p2 in o2. */
const PARENT: ReadonlyArray<readonly [Node, Node]> = [
  [P1, O1],
  [P2, O2],
  [D1, P1],
  [D2, P2],
];
const USERS = ['u1', 'u2'];
const PERMISSIONS = ['doc:read', 'doc:update'];
const EVERYWHERE = ['$global', 'org', 'project', 'doc'];

// Where each role may be held; undefined is $global. Every role lists its scope types: rbacToIR stores a role without them at $global only (G21), so an assignment of one at a node is outside what the IR sees.
const HELD_AT: ReadonlyArray<readonly [string, readonly (Node | undefined)[]]> = [
  ['reader', [undefined, O1, O2, P1, P2, D1, D2]],
  ['writer', [O1, O2, P1, P2]],
  ['staff', [undefined]],
  ['banned', [undefined, O1, O2, P1, P2, D1, D2]],
];
const ROLE_NAMES = HELD_AT.map(([name]) => name);

interface Held {
  readonly user: string;
  readonly role: string;
  readonly at: Node | undefined;
}

interface Drawn {
  readonly grants: { readonly reader: readonly string[]; readonly writer: readonly string[]; readonly staff: readonly string[]; readonly banned: readonly string[] };
  readonly held: readonly Held[];
  readonly ceilings: ReadonlyArray<readonly string[]>;
}

const role = (name: string, grants: readonly string[], extra: Partial<RoleDef>): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((permission) => ({ permission })) });

/** `writer` extends `reader`; `banned` is a deny role: its grants are what it denies. */
const rolesOf = (g: Drawn['grants']): RoleDef[] => [
  role('reader', g.reader, { scopeTypes: EVERYWHERE }),
  role('writer', g.writer, { extends: ['reader'], scopeTypes: ['org', 'project'] }),
  role('staff', g.staff, { scopeTypes: ['$global'] }),
  role('banned', g.banned, { scopeTypes: EVERYWHERE, deny: true }),
];

/** The scope chain as the ORM and the adapter would compile it; `mergeFragments` roots `org` at `$global`. */
const SCOPES: IRFragment = {
  model: 'orm',
  types: {
    org: { relations: {}, permissions: {} },
    project: { relations: { parent: { allowed: ['org'], source: { kind: 'ancestor', via: 'adapter' } } }, permissions: {} },
    doc: { relations: { parent: { allowed: ['project'], source: { kind: 'ancestor', via: 'adapter' } } }, permissions: {} },
  },
};

const scopes = new FakeScopeResolver({ types: ['org', 'project', 'doc'], nodes: [{ ref: O1 }, { ref: O2 }, ...PARENT.map(([ref, parent]) => ({ ref, parent }))] });

function registry(): PermissionRegistryImpl {
  const r = new PermissionRegistryImpl();
  r.register(
    PERMISSIONS.map((name) => ({ name, types: ['doc'] })),
    'test',
  );
  r.freeze();
  return r;
}

const held: fc.Arbitrary<Held> = fc.oneof(...HELD_AT.map(([name, at]) => fc.record({ user: fc.constantFrom(...USERS), role: fc.constant(name), at: fc.constantFrom(...at) })));

const drawn: fc.Arbitrary<Drawn> = fc.record({
  grants: fc.record({ reader: fc.subarray(PERMISSIONS), writer: fc.subarray(PERMISSIONS), staff: fc.subarray(PERMISSIONS), banned: fc.subarray(PERMISSIONS, { minLength: 1 }) }),
  // One row per subject, role and scope: a second one is a store error.
  held: fc.uniqueArray(held, { maxLength: 8, selector: (h) => JSON.stringify([h.user, h.role, h.at ?? null]) }),
  ceilings: fc.array(fc.subarray(ROLE_NAMES), { maxLength: 2 }),
});

async function build(w: Drawn): Promise<AgreementWorld> {
  const defs = rolesOf(w.grants);
  const reg = registry();
  const graph = compileRoles(defs);
  const { ir, conflicts } = mergeFragments([rbacToIR(graph, compileGrants(graph, reg), reg), SCOPES]);
  const problems = validateIR(ir);
  if (conflicts.length > 0 || ir.opaque.length > 0 || problems.length > 0) throw new Error(`the generator left the fragment rbacToIR compiles exactly: ${JSON.stringify({ conflicts, opaque: ir.opaque, problems })}`);

  const assignments = w.held.map((h, i): Assignment => ({ id: `a${i}`, subject: { type: 'user', id: h.user }, role: h.role, scope: h.at ?? GLOBAL, source: 'test' }));
  const model = new RbacModel({ roles: new MemoryRoleStore(defs), assignments: new MemoryAssignmentStore(assignments), log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: reg }));
  model.grantIndex();

  const tuples = new MemoryTupleSource(ir);
  for (const [child, parent] of PARENT) tuples.add(child, 'parent', parent);
  for (const h of w.held) tuples.add(h.at ?? GLOBAL_OBJECT, h.role, { type: 'user', id: h.user });

  const principals: EvalInput['principal'][] = USERS.flatMap((id) => [{ type: 'user', id }, ...w.ceilings.map((roles) => ({ type: 'user', id, ceiling: { roles } }))]);
  const requests: EvalInput[] = principals.flatMap((principal) => [D1, D2].flatMap((resource) => PERMISSIONS.map((permission) => ({ principal, permission, resource }))));
  return {
    ir,
    tuples,
    requests,
    engine: async (r) => {
      const roles = r.principal.ceiling?.roles;
      const principal = roles === undefined ? userPrincipal(r.principal.id) : withCeiling(userPrincipal(r.principal.id), { roles: [...roles] });
      return voteTruth(await model.evaluate({ principal, permission: r.permission, resource: r.resource }, fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] })));
    },
  };
}

/** u1 reads through `reader` at o1 and is banned at p1, the project of d1; u2 reads through `reader` at o1 only. */
const PINNED: Drawn = {
  grants: { reader: ['doc:read'], writer: [], staff: [], banned: ['doc:read'] },
  held: [
    { user: 'u1', role: 'reader', at: O1 },
    { user: 'u1', role: 'banned', at: P1 },
    { user: 'u2', role: 'reader', at: O1 },
  ],
  ceilings: [],
};

describe('authz-rbac: IR agreement (Z6)', function () {
  this.timeout(600000);

  it('a role ceiling never lifts a deny role, in the engine and in the evaluator', async () => {
    const world = await build(PINNED);
    const evaluator = new IREvaluator(world.ir, world.tuples);
    const both = async (id: string, roles?: readonly string[]): Promise<Truth[]> => {
      const request: EvalInput = { principal: roles === undefined ? { type: 'user', id } : { type: 'user', id, ceiling: { roles } }, permission: 'doc:read', resource: D1 };
      return [await world.engine(request), (await evaluator.check(request)).truth];
    };
    expect(await both('u1')).to.deep.equal(['deny', 'deny']);
    expect(await both('u1', ['reader'])).to.deep.equal(['deny', 'deny']);
    expect(await both('u1', ['reader', 'banned'])).to.deep.equal(['deny', 'deny']);
    expect(await both('u2')).to.deep.equal(['allow', 'allow']);
    expect(await both('u2', ['reader'])).to.deep.equal(['allow', 'allow']);
    expect(await both('u2', ['writer'])).to.deep.equal(['deny', 'deny']);
    expect(await both('u2', [])).to.deep.equal(['deny', 'deny']);
  });

  it('RbacModel and IREvaluator agree on random grants, assignments and role ceilings', async () => {
    await irAgreement(drawn, build);
  });
});
