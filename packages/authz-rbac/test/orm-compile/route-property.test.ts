import { GLOBAL } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, Principal, ResourceRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import type { RoleDef } from '../../src/index.js';
import { RbacRoleGraphSource, RbacScopeAttributeSource } from '../../src/orm/index.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { propertyPart, propertyRuns } from './rules-arbitraries.js';
import { DAY, PERMISSIONS, ROLES, RouteWorld, at, registerRouteSources, routeArgs, service, team, u, user } from './route-world.js';

const SEED = Number(process.env.L4B_SEED ?? 20261005);
const RUNS = propertyRuns('L4B_ROUTE_RUNS', 300);
const part = propertyPart(RUNS);

const ROLE_NAMES = [...ROLES.map((r) => r.name), 'nope'];
// Roles only the second graph defines; under ROLES they are unknown, and their assignments count for nothing.
const SECOND_ONLY = ['dual', 'chief', 'reader'];
const AT = ['self-and-descendants', 'descendants'] as const;
const SUBJECTS: readonly AssignmentSubject[] = [u('u1'), u('u2'), u('u3'), { type: 'service', id: 's1' }, { type: 'service', id: 's2' }, team('t1'), team('t2')];
const SCOPES: readonly ResourceRef[] = [GLOBAL, at('doc'), at('org'), at('project'), ...['1', '2', '3', '6', '7', '8'].map((id) => at('doc', id)), ...['10', '11', '12', '13'].map((id) => at('project', id)), ...['o1', 'o2', 'O1', 'o10'].map((id) => at('org', id)), at('team', 't1'), at('team', 't2')];
const TAGS = ['inspect', 'review', 'x'];
const EXPIRY = ['none', 'past', 'future'] as const;

// Weighted towards what makes the vote use args v2: implied 'descendants' roles, and scopes with ids (rows depend on them).
const IMPLYING_BELOW = ['team.lead', 'lead.plus', 'robot'];
const assignmentArb = fc.record({
  subject: fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...SUBJECTS.slice(0, 2)) }, { weight: 2, arbitrary: fc.constantFrom(...SUBJECTS) }),
  role: fc.oneof({ weight: 2, arbitrary: fc.constantFrom(...IMPLYING_BELOW) }, { weight: 3, arbitrary: fc.constantFrom(...ROLE_NAMES) }, { weight: 2, arbitrary: fc.constantFrom(...SECOND_ONLY) }),
  scope: fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...SCOPES.filter((s) => s.id !== undefined && s.type !== 'team')) }, { weight: 2, arbitrary: fc.constantFrom(...SCOPES) }),
  tags: fc.subarray(TAGS),
  expiry: fc.constantFrom(...EXPIRY),
});

/** A membership of a user in a team set, so set assignments meet usable and unusable memberships. */
const membershipArb = fc.record({ user: fc.constantFrom('u1', 'u2', 'u3'), team: fc.constantFrom('t1', 't2'), expiry: fc.constantFrom(...EXPIRY) });

/*
 * Route review M1: a second role graph, drawn for two runs in three, beside ROLES. 'dual' implies editor through two
 * entries with different `at` (so 'self-and-descendants' is decided by a mix), 'chief' implies the off-ladder auditor
 * (whose doc:export has grantedAt: off-ladder provenance through an implied role), and the off-ladder 'reader' is
 * extended by ladder roles. Tags, bypass marks and the reader's grant vary.
 */
const graphArb = fc.record({
  dualFirst: fc.constantFrom(...AT),
  dualTags: fc.tuple(fc.subarray(TAGS), fc.subarray(TAGS)),
  chiefAt: fc.constantFrom(...AT),
  chiefBypass: fc.subarray(['restrict', 'cap'] as const),
  chiefImpliesReader: fc.boolean(),
  readerGrantedAt: fc.option(fc.subarray(['org', 'project', '$global'], { minLength: 1 }), { nil: undefined }),
  readerTag: fc.option(fc.constantFrom(...TAGS), { nil: undefined }),
  extendsReader: fc.subarray(['viewer', 'commenter']),
});

type GraphSpec = typeof graphArb extends fc.Arbitrary<infer T> ? T : never;

function rolesOf(g: GraphSpec): RoleDef[] {
  const other = g.dualFirst === 'descendants' ? 'self-and-descendants' : 'descendants';
  const extra = (name: string, def: Partial<RoleDef>): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants: [], ...def });
  return [
    ...ROLES.map((r) => (g.extendsReader.includes(r.name) ? { ...r, extends: [...r.extends, 'reader'] } : r)),
    extra('dual', {
      implies: [
        { role: 'editor', at: g.dualFirst, tags: [...g.dualTags[0]] },
        { role: 'editor', at: other, tags: [...g.dualTags[1]] },
      ],
    }),
    extra('chief', { implies: [{ role: 'auditor', at: g.chiefAt, bypass: [...g.chiefBypass] }, ...(g.chiefImpliesReader ? [{ role: 'reader', at: g.chiefAt }] : [])] }),
    extra('reader', { grants: [{ permission: 'doc:export', ...(g.readerGrantedAt ? { grantedAt: [...g.readerGrantedAt] } : {}), ...(g.readerTag ? { requiresTag: g.readerTag } : {}) }] }),
  ];
}

const worldArb = fc.record({
  graph: fc.option(graphArb, { freq: 3, nil: undefined }),
  assignments: fc.array(assignmentArb, { minLength: 1, maxLength: 12 }),
  memberships: fc.array(membershipArb, { maxLength: 2 }),
  // u1, u2 and the two service principals, whose config roles the ceiling filters too.
  ceilings: fc.tuple(...[0, 1, 2, 3].map(() => fc.option(fc.subarray(ROLE_NAMES), { nil: undefined }))),
  permissions: fc.subarray([...PERMISSIONS], { minLength: 2, maxLength: 3 }),
});

type WorldSpec = typeof worldArb extends fc.Arbitrary<infer T> ? T : never;

function rowsOf(spec: WorldSpec, now: number): Assignment[] {
  const expiresAt = (e: (typeof EXPIRY)[number]) => (e === 'none' ? null : new Date(now + (e === 'past' ? -DAY : DAY)));
  let n = 0;
  return [...spec.assignments.map((a): Assignment => ({ id: `p${++n}`, subject: a.subject, role: a.role, scope: a.scope, tags: [...a.tags], expiresAt: expiresAt(a.expiry), source: 'db' })), ...spec.memberships.map((m): Assignment => ({ id: `p${++n}`, subject: u(m.user), role: 'team.member', scope: at('team', m.team), expiresAt: expiresAt(m.expiry), source: 'db' }))];
}

describe('authz-rbac orm-compile: grant routes, check ⇔ listed (property)', function () {
  this.timeout(3600000);

  let db: RootOrm;
  let undoSource: (() => void) | undefined;

  before(async function () {
    db = await RootOrm.open(this, 'l4b_route_prop');
    await (await testHost.domains()).service('root');
    undoSource = registerRouteSources();
  });

  after(async () => {
    undoSource?.();
    DI.uncache(RbacRoleGraphSource);
    DI.uncache(RbacScopeAttributeSource);
    await db?.close();
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      let world: RouteWorld;

      before(async () => {
        world = await RouteWorld.open(db, kind);
      });

      after(async () => {
        await world?.close();
      });

      it(`for every principal and row, check() allows exactly the rows authz-orm lists and the in-memory list filter keeps (seed ${SEED}, ${part.label})`, async () => {
        const stats = { v2: 0, terms: 0, listed: 0, sqlMs: 0, second: 0 };
        let graph = 'null';
        const started = Date.now();
        await fc.assert(
          fc.asyncProperty(
            worldArb,
            part.only(async (spec) => {
              const key = JSON.stringify(spec.graph ?? null);
              if (key !== graph) {
                await world.configure(spec.graph ? { roles: rolesOf(spec.graph) } : {});
                graph = key;
              }
              if (spec.graph) stats.second++;
              await world.assign(rowsOf(spec, Date.now()));
              const principals: Principal[] = [user('u1', spec.ceilings[0]), user('u2', spec.ceilings[1]), user('u3'), service('s1', spec.ceilings[2]), service('s2', spec.ceilings[3])];
              for (const p of principals) {
                for (const permission of spec.permissions) {
                  const residual = await world.residual(p, permission);
                  stats.terms++;
                  if (routeArgs(residual).length > 0) stats.v2++;
                  const allowed = await world.allowed(p, permission);
                  const t0 = Date.now();
                  const listed = await world.listed(p, permission);
                  stats.sqlMs += Date.now() - t0;
                  stats.listed += listed.length;
                  const why = `${kind} ${p.type}:${p.id} ceiling ${JSON.stringify(p.ceiling?.roles)} ${permission}: ${JSON.stringify(residual)}`;
                  expect(listed, `listed, ${why}`).to.deep.equal(allowed);
                  expect(await world.inMemory(residual, p), `in memory, ${why}`).to.deep.equal(allowed);
                }
              }
            }),
          ),
          { seed: SEED, numRuns: part.numRuns, endOnFailure: true },
        );
        console.log(`      ${kind}: ${part.label} in ${Date.now() - started} ms (SQL ${stats.sqlMs} ms over ${stats.terms} lists); ${stats.v2} lists with args v2, ${stats.listed} rows listed, ${stats.second} runs on the second graph`);
        expect(stats.v2, 'lists with args v2').to.be.at.least(part.min(RUNS / 2));
        expect(stats.listed, 'rows listed').to.be.at.least(part.min(RUNS));
        expect(stats.second, 'runs on the second graph').to.be.at.least(part.min(RUNS / 2));
      });
    });
  }
});
