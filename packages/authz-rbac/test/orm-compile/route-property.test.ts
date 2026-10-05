import { GLOBAL } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, Principal, ResourceRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { RbacRoleGraphSource } from '../../src/orm/index.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { DAY, PERMISSIONS, ROLES, RouteGraphSource, RouteWorld, at, registerThresholdStub, routeArgs, service, team, u, user } from './route-world.js';

const SEED = 20261005;
const RUNS = Number(process.env.L4B_ROUTE_RUNS ?? 300);

const ROLE_NAMES = [...ROLES.map((r) => r.name), 'nope'];
const SUBJECTS: readonly AssignmentSubject[] = [u('u1'), u('u2'), u('u3'), { type: 'service', id: 's1' }, { type: 'service', id: 's2' }, team('t1'), team('t2')];
const SCOPES: readonly ResourceRef[] = [GLOBAL, at('doc'), at('org'), at('project'), ...['1', '2', '3', '6', '7', '8'].map((id) => at('doc', id)), ...['10', '11', '12', '13'].map((id) => at('project', id)), ...['o1', 'o2', 'O1', 'o10'].map((id) => at('org', id)), at('team', 't1'), at('team', 't2')];
const TAGS = ['inspect', 'review', 'x'];
const EXPIRY = ['none', 'past', 'future'] as const;

// Weighted towards what makes the vote use args v2: implied 'descendants' roles, and scopes with ids (rows depend on them).
const IMPLYING_BELOW = ['team.lead', 'lead.plus', 'robot'];
const assignmentArb = fc.record({
  subject: fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...SUBJECTS.slice(0, 2)) }, { weight: 2, arbitrary: fc.constantFrom(...SUBJECTS) }),
  role: fc.oneof({ weight: 2, arbitrary: fc.constantFrom(...IMPLYING_BELOW) }, { weight: 3, arbitrary: fc.constantFrom(...ROLE_NAMES) }),
  scope: fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...SCOPES.filter((s) => s.id !== undefined && s.type !== 'team')) }, { weight: 2, arbitrary: fc.constantFrom(...SCOPES) }),
  tags: fc.subarray(TAGS),
  expiry: fc.constantFrom(...EXPIRY),
});

/** A membership of a user in a team set, so set assignments meet usable and unusable memberships. */
const membershipArb = fc.record({ user: fc.constantFrom('u1', 'u2', 'u3'), team: fc.constantFrom('t1', 't2'), expiry: fc.constantFrom(...EXPIRY) });

const worldArb = fc.record({
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
  let undoStub: (() => void) | undefined;

  before(async function () {
    db = await RootOrm.open(this, 'l4b_route_prop');
    await (await testHost.domains()).service('root');
    undoSource = testHost.registerInRoot(RbacRoleGraphSource, testHost.instance(new RouteGraphSource()));
    undoStub = registerThresholdStub();
  });

  after(async () => {
    undoStub?.();
    undoSource?.();
    DI.uncache(RbacRoleGraphSource);
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

      it(`for every principal and row, check() allows exactly the rows authz-orm lists and the in-memory list filter keeps (seed ${SEED}, ${RUNS} runs)`, async () => {
        const stats = { v2: 0, terms: 0, listed: 0, sqlMs: 0 };
        const started = Date.now();
        await fc.assert(
          fc.asyncProperty(worldArb, async (spec) => {
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
          { seed: SEED, numRuns: RUNS, endOnFailure: true },
        );
        console.log(`      ${kind}: ${RUNS} runs in ${Date.now() - started} ms (SQL ${stats.sqlMs} ms over ${stats.terms} lists); ${stats.v2} lists with args v2, ${stats.listed} rows listed`);
        expect(stats.v2, 'lists with args v2').to.be.at.least(RUNS / 2);
        expect(stats.listed, 'rows listed').to.be.at.least(RUNS);
      });
    });
  }
});
