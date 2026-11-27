import * as chai from 'chai';
import 'mocha';

import { GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { EvaluationContext, ResourceRef, Vote } from '@spinajs/authz';
import { ManualClock, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { AssignmentStore, DbAssignmentStore, MemoryRoleStore, RbacModel, scopeToColumns, subjectKeyOf, subjectToColumns } from '../../src/index.js';
import type { Assignment, AssignmentSubject, RbacModelOptions, RoleDef } from '../../src/index.js';
import { bootDb, DB_KINDS } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { microtasks, within } from '../support/deadline.js';

const expect = chai.expect;
// The load counts are the point of a failure message; chai shortens objects by default.
chai.config.truncateThreshold = 0;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const TTL = 60_000;
const FILES: ResourceRef = { type: 'file' };
const alice = userPrincipal('alice');
const ALICE: AssignmentSubject = { type: 'user', id: 'alice' };
const VIEWER: RoleDef = { name: 'viewer', extends: [], assignable: true, source: 'test', grants: [{ permission: 'file:read' }] };
const CONCURRENT = 10;

/** Counts the loads that reach the DB store. */
class CountedAssignments extends AssignmentStore {
  readonly name = 'counted';
  loads = 0;

  constructor(private readonly inner: AssignmentStore) {
    super();
  }

  forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]> {
    this.loads++;
    return this.inner.forSubjects(subjects, at);
  }

  holders(role: string, scope: ResourceRef, at: Date): Promise<readonly AssignmentSubject[]> {
    return this.inner.holders(role, scope, at);
  }

  byId(id: string): Promise<Assignment | null> {
    return this.inner.byId(id);
  }
}

const check = (model: RbacModel, ctx: EvaluationContext, resource: ResourceRef = FILES): Promise<Vote> => Promise.resolve(model.evaluate({ principal: alice, permission: 'file:read', resource }, ctx));

const request = (clock: ManualClock) => fakeEvaluationContext({ now: clock.now() });

for (const kind of DB_KINDS) {
  describe(`authz-rbac checks beside a nested transaction (${kind})`, function () {
    this.timeout(600_000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'v4_orm_tq_01e_queue_safe_caches');
      await db.driver
        .insert()
        .into('authz_assignment')
        .values({ id: 'a1', ...subjectToColumns(ALICE), subject_key: subjectKeyOf(ALICE), role: 'viewer', ...scopeToColumns(GLOBAL), tags: '', expires_at: null, granted_by: null, source: 'db', created_at: NOW });
    });

    after(async () => {
      await db?.dispose();
    });

    async function rbac(opts: Partial<RbacModelOptions> = {}) {
      const registry = new PermissionRegistryImpl();
      registry.register([{ name: 'file:read' }], 'test');
      registry.freeze();
      const clock = new ManualClock(NOW);
      const assignments = new CountedAssignments(db.container.resolve(DbAssignmentStore));
      const model = new RbacModel({ roles: new MemoryRoleStore([VIEWER]), assignments, clock, log: { warn: () => undefined }, ...opts });
      await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
      return { model, clock, assignments };
    }

    /** A check and, `ticks` microtasks later, a nested transaction making the same check in the same request, under a deadline. */
    async function beside(model: RbacModel, ctx: EvaluationContext, ticks: number, what: string, resource: ResourceRef = FILES): Promise<Vote> {
      const nested = async (): Promise<Vote> => {
        await microtasks(ticks);
        return db.driver.transaction(() => check(model, ctx, resource));
      };
      const votes = await within(10_000, `${what}, ${ticks} microtasks later`, db.driver.transaction(() => Promise.all([check(model, ctx, resource), nested()])));
      for (const vote of votes) expect(vote.permitWhen).to.deep.equal(TRUE);
      return votes[0];
    }

    describe('AssignmentCache over DbAssignmentStore', () => {
      it('a check settles beside a nested transaction that makes the same check in the same request, cold and warm, however late it starts', async () => {
        for (const warm of [false, true]) {
          for (let ticks = 0; ticks <= 60; ticks++) {
            const { model, clock } = await rbac();
            if (warm) await check(model, request(clock));
            await beside(model, request(clock), ticks, `an assignment check beside a nested one, ${warm ? 'warm' : 'cold'}`);
          }
        }
      });

      it('store loads: concurrent cold checks load each, a settled answer serves later checks, an expired one is loaded again by each', async () => {
        const loads = async (model: RbacModel, assignments: CountedAssignments, ctx: () => EvaluationContext): Promise<number> => {
          const before = assignments.loads;
          await Promise.all(Array.from({ length: CONCURRENT }, () => check(model, ctx())));
          return assignments.loads - before;
        };
        const one = await rbac();
        const shared = request(one.clock);
        const sameRequest = await loads(one.model, one.assignments, () => shared);
        const other = await rbac();
        const requests = await loads(other.model, other.assignments, () => request(other.clock));
        const warm = await loads(other.model, other.assignments, () => request(other.clock));
        other.clock.advance(TTL);
        const expired = await loads(other.model, other.assignments, () => request(other.clock));

        expect({ sameRequest, requests, warm, expired }).to.deep.equal({ sameRequest: CONCURRENT, requests: CONCURRENT, warm: 0, expired: CONCURRENT });
      });
    });
  });
}
