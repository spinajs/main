import * as chai from 'chai';
import 'mocha';

import { FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { EvaluationContext, ResourceRef, Vote } from '@spinajs/authz';
import { ManualClock, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import { QueryContext } from '@spinajs/orm';

import { AssignmentStore, DbAssignmentStore, DbMembershipStore, DbRuleStore, MembershipStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel, RuleStore, scopeToColumns, subjectKeyOf, subjectToColumns } from '../../src/index.js';
import type { Assignment, AssignmentSubject, RbacModelOptions, RoleDef, RuleDef } from '../../src/index.js';
import { bootDb, DB_KINDS, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { microtasks, within } from '../support/deadline.js';

const expect = chai.expect;
// The load counts are the point of a failure message; chai shortens objects by default.
chai.config.truncateThreshold = 0;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const TTL = 60_000;
const FILES: ResourceRef = { type: 'file' };
const F1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');
const ALICE: AssignmentSubject = { type: 'user', id: 'alice' };
const VIEWER: RoleDef = { name: 'viewer', extends: [], assignable: true, source: 'test', grants: [{ permission: 'file:read' }] };
const CONCURRENT = 10;

/** Counts the loads that reach the DB store; `hold` keeps an answer back after the store answered. It does not answer `inTransaction()`, as a third-party store may not. */
class CountedAssignments extends AssignmentStore {
  readonly name = 'counted';
  loads = 0;
  hold?: Promise<void>;

  constructor(private readonly inner: AssignmentStore) {
    super();
  }

  async forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]> {
    const hold = this.hold;
    this.loads++;
    const rows = await this.inner.forSubjects(subjects, at);
    await hold;
    return rows;
  }

  holders(role: string, scope: ResourceRef, at: Date): Promise<readonly AssignmentSubject[]> {
    return this.inner.holders(role, scope, at);
  }

  byId(id: string): Promise<Assignment | null> {
    return this.inner.byId(id);
  }
}

/** CountedAssignments that answers `inTransaction()` as the DB store does. */
class CountedDbAssignments extends CountedAssignments {
  constructor(private readonly db: DbAssignmentStore) {
    super(db);
  }

  inTransaction(): boolean {
    return this.db.inTransaction();
  }
}

/** Counts the reads that reach the DB membership store; `failures` fail before reaching it; `hold` keeps an answer back after the store answered. */
class CountedMembership extends MembershipStore {
  loads = 0;
  answered = 0;
  failures = 0;
  hold?: Promise<void>;

  constructor(private readonly inner: MembershipStore) {
    super();
  }

  async setsOf(memberKeys: readonly string[], at: Date): Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]> {
    this.loads++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('membership store unavailable');
    }
    const sets = await this.inner.setsOf(memberKeys, at);
    this.answered++;
    await this.hold;
    return sets;
  }

  membersOf(setKey: string, at: Date): Promise<readonly string[]> {
    return this.inner.membersOf(setKey, at);
  }
}

/** Counts the reads that reach the DB rule store; `failures` fail before reaching it. */
class CountedRules extends RuleStore {
  readonly name = 'counted-rules';
  loads = 0;
  failures = 0;

  constructor(private readonly inner: RuleStore) {
    super();
  }

  async forPath(path: readonly ResourceRef[], at: Date): Promise<readonly RuleDef[]> {
    this.loads++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('rule store unavailable');
    }
    return this.inner.forPath(path, at);
  }

  version(): Promise<string> {
    return this.inner.version();
  }
}

/** A type-level check, or a check of `resource`: a type-level request refuses rules a DB store may hold. */
const check = (model: RbacModel, ctx: EvaluationContext, resource: ResourceRef = FILES, principal = alice): Promise<Vote> => Promise.resolve(model.evaluate({ principal, permission: 'file:read', resource }, ctx));

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

    async function rbac(opts: Partial<RbacModelOptions> = {}, store: { readonly answers: boolean } = { answers: true }) {
      const registry = new PermissionRegistryImpl();
      registry.register([{ name: 'file:read' }], 'test');
      registry.freeze();
      const clock = new ManualClock(NOW);
      const dbStore = db.container.resolve(DbAssignmentStore);
      const assignments = store.answers ? new CountedDbAssignments(dbStore) : new CountedAssignments(dbStore);
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

      it('an outside check is loading when a nested transaction makes the same check in the same request: neither waits for the other, however late it starts', async () => {
        for (let ticks = 0; ticks <= 60; ticks++) {
          const { model, clock } = await rbac();
          const ctx = request(clock);
          const nested = async (): Promise<Vote> => {
            await microtasks(ticks);
            return db.driver.transaction(() => check(model, ctx));
          };
          const votes = await within(10_000, `an outside assignment check beside a nested one, ${ticks} microtasks later`, Promise.all([check(model, ctx), nested()]));
          for (const vote of votes) expect(vote.permitWhen).to.deep.equal(TRUE);
        }
      });

      it('a check inside a nested transaction does not wait for a load an outside check of the same request started', async () => {
        const { model, clock, assignments } = await rbac();
        const ctx = request(clock);
        let release = (): void => undefined;
        assignments.hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const outside = check(model, ctx);
        await within(10_000, 'the outside load starts', (async () => {
          while (assignments.loads === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        })());
        assignments.hold = undefined;
        const inside = await within(10_000, 'a nested check while an outside load is held', db.driver.transaction(() => check(model, ctx)));
        release();
        expect((await outside).permitWhen).to.deep.equal(TRUE);
        expect({ inside: inside.permitWhen, loads: assignments.loads }).to.deep.equal({ inside: TRUE, loads: 2 });
      });

      const loads = async (model: RbacModel, assignments: CountedAssignments, ctx: () => EvaluationContext): Promise<number> => {
        const before = assignments.loads;
        await Promise.all(Array.from({ length: CONCURRENT }, () => check(model, ctx())));
        return assignments.loads - before;
      };

      it('store loads: outside a transaction concurrent cold checks share one load, also at TTL expiry; inside one each loads', async () => {
        const one = await rbac();
        const shared = request(one.clock);
        const sameRequest = await loads(one.model, one.assignments, () => shared);
        const other = await rbac();
        const requests = await loads(other.model, other.assignments, () => request(other.clock));
        const warm = await loads(other.model, other.assignments, () => request(other.clock));
        other.clock.advance(TTL);
        const expired = await loads(other.model, other.assignments, () => request(other.clock));
        const third = await rbac();
        const insideTransaction = await db.driver.transaction(() => loads(third.model, third.assignments, () => request(third.clock)));

        expect({ sameRequest, requests, warm, expired, insideTransaction }).to.deep.equal({ sameRequest: 1, requests: 1, warm: 0, expired: 1, insideTransaction: CONCURRENT });
      });

      it('store loads of a store without inTransaction(): concurrent cold checks load each, a settled answer serves later requests, an expired one is loaded again by each', async () => {
        const one = await rbac({}, { answers: false });
        const shared = request(one.clock);
        const sameRequest = await loads(one.model, one.assignments, () => shared);
        const other = await rbac({}, { answers: false });
        const requests = await loads(other.model, other.assignments, () => request(other.clock));
        const warm = await loads(other.model, other.assignments, () => request(other.clock));
        other.clock.advance(TTL);
        const expired = await loads(other.model, other.assignments, () => request(other.clock));

        expect({ sameRequest, requests, warm, expired }).to.deep.equal({ sameRequest: CONCURRENT, requests: CONCURRENT, warm: 0, expired: CONCURRENT });
      });

      it('a grant read inside a transaction that rolls back does not allow a later request', async () => {
        const BOB: AssignmentSubject = { type: 'user', id: 'bob' };
        const bob = userPrincipal('bob');
        const { model, clock } = await rbac();
        const rollBack = new Error('roll back');
        let insideTransaction: unknown;
        const outcome = await db.driver
          .transaction(async () => {
            await db.driver
              .insert()
              .into('authz_assignment')
              .values({ id: 'b1', ...subjectToColumns(BOB), subject_key: subjectKeyOf(BOB), role: 'viewer', ...scopeToColumns(GLOBAL), tags: '', expires_at: null, granted_by: null, source: 'db', created_at: NOW });
            insideTransaction = (await check(model, request(clock), FILES, bob)).permitWhen;
            throw rollBack;
          })
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(outcome).to.equal(rollBack);
        const left: unknown[] = await rawQuery(db.driver, "SELECT id FROM authz_assignment WHERE id = 'b1'");
        expect(left, 'the rollback removed the grant').to.have.length(0);
        clock.advance(1000);
        const laterRequest = (await check(model, request(clock), FILES, bob)).permitWhen;

        expect({ insideTransaction, laterRequest }).to.deep.equal({ insideTransaction: TRUE, laterRequest: FALSE });
      });
    });

    describe('the request memo of DbMembershipStore.setsOf', () => {
      const TEAM: AssignmentSubject = { set: { role: 'team.member', scope: { type: 'team', id: 't1' } } };
      const TEAM_MEMBER: RoleDef = { name: 'team.member', extends: [], assignable: true, source: 'test', subjectSet: true, grants: [] };
      const membershipRow = { member_key: subjectKeyOf(ALICE), set_key: subjectKeyOf(TEAM), depth: 1, expires_at: null };

      beforeEach(async () => {
        await rawQuery(db.driver, 'DELETE FROM authz_subject_membership', [], QueryContext.Delete);
        await db.driver.insert().into('authz_subject_membership').values(membershipRow);
      });

      async function withSets() {
        const membership = new CountedMembership(db.container.resolve(DbMembershipStore));
        const viewerOfTeam: Assignment = { id: 's1', subject: TEAM, role: 'viewer', scope: GLOBAL, source: 'test' };
        const built = await rbac({ roles: new MemoryRoleStore([VIEWER, TEAM_MEMBER]), assignments: new MemoryAssignmentStore([viewerOfTeam]), membership });
        return { ...built, membership };
      }

      it('a check settles beside a nested transaction that makes the same check in the same request, cold and warm, however late it starts', async () => {
        for (const warm of [false, true]) {
          for (let ticks = 0; ticks <= 60; ticks++) {
            const { model, clock } = await withSets();
            if (warm) await check(model, request(clock));
            await beside(model, request(clock), ticks, `a membership check beside a nested one, ${warm ? 'warm' : 'cold'}`);
          }
        }
      });

      it('store loads: concurrent checks of a request read each, a settled answer serves the rest of the request', async () => {
        const { model, clock, membership } = await withSets();
        const ctx = request(clock);
        await Promise.all(Array.from({ length: CONCURRENT }, () => check(model, ctx)));
        const concurrent = membership.loads;
        await Promise.all(Array.from({ length: CONCURRENT }, () => check(model, ctx)));
        expect({ concurrent, settled: membership.loads - concurrent }).to.deep.equal({ concurrent: CONCURRENT, settled: 0 });
      });

      it('a failed read is not kept: the next check of the request reads again', async () => {
        const { model, clock, membership } = await withSets();
        const ctx = request(clock);
        membership.failures = 1;
        const failed = await check(model, ctx).then(
          () => undefined,
          (e: Error) => e,
        );
        expect(failed?.message).to.equal('membership store unavailable');
        expect((await check(model, ctx)).permitWhen).to.deep.equal(TRUE);
        expect(membership.loads).to.equal(2);
      });

      it('a membership read before an invalidate, settled or in flight, does not answer a check of the request after it', async () => {
        for (const inFlight of [false, true]) {
          await rawQuery(db.driver, 'DELETE FROM authz_subject_membership', [], QueryContext.Delete);
          await db.driver.insert().into('authz_subject_membership').values(membershipRow);
          const { model, clock, membership } = await withSets();
          const ctx = request(clock);
          let release = (): void => undefined;
          if (inFlight) {
            membership.hold = new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          const first = check(model, ctx);
          while (inFlight && membership.answered === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          if (!inFlight) expect((await first).permitWhen).to.deep.equal(TRUE);
          await rawQuery(db.driver, 'DELETE FROM authz_subject_membership', [], QueryContext.Delete);
          model.invalidate([`subject:${subjectKeyOf(ALICE)}`]);
          release();
          membership.hold = undefined;
          await first;
          expect((await check(model, ctx)).permitWhen, inFlight ? 'in flight' : 'settled').to.deep.equal(FALSE);
        }
      });
    });

    describe('the request memo of DbRuleStore.forPath', () => {
      async function withRules() {
        const rules = new CountedRules(db.container.resolve(DbRuleStore));
        const built = await rbac({ assignments: new MemoryAssignmentStore([{ id: 'a1', subject: ALICE, role: 'viewer', scope: GLOBAL, source: 'test' }]), rules });
        return { ...built, rules };
      }

      it('a check settles beside a nested transaction that makes the same check in the same request, cold and warm, however late it starts', async () => {
        for (const warm of [false, true]) {
          for (let ticks = 0; ticks <= 60; ticks++) {
            const { model, clock } = await withRules();
            if (warm) await check(model, request(clock), F1);
            await beside(model, request(clock), ticks, `a rule check beside a nested one, ${warm ? 'warm' : 'cold'}`, F1);
          }
        }
      });

      it('store loads: concurrent checks of a request read each, a settled answer serves the rest of the request', async () => {
        const { model, clock, rules } = await withRules();
        const ctx = request(clock);
        await Promise.all(Array.from({ length: CONCURRENT }, () => check(model, ctx, F1)));
        const concurrent = rules.loads;
        await Promise.all(Array.from({ length: CONCURRENT }, () => check(model, ctx, F1)));
        expect({ concurrent, settled: rules.loads - concurrent }).to.deep.equal({ concurrent: CONCURRENT, settled: 0 });
      });

      it('a failed read is not kept: the next check of the request reads again', async () => {
        const { model, clock, rules } = await withRules();
        const ctx = request(clock);
        rules.failures = 1;
        const failed = await check(model, ctx, F1).then(
          () => undefined,
          (e: Error) => e,
        );
        expect(failed?.message).to.equal('rule store unavailable');
        expect((await check(model, ctx, F1)).permitWhen).to.deep.equal(TRUE);
        expect(rules.loads).to.equal(2);
      });
    });
  });
}
