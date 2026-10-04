import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AuthzAdminFailure, AuthzClock, AuthzConfigError, AuthzDomains, GLOBAL } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, AuthzTx, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { OrmDriver, QueryContext } from '@spinajs/orm';

import { ASSIGNMENT_LIST_MAX_LIMIT, AdminAssignmentStore, AssignmentStore, AuthzRbac_2026_10_01_00_00_00, DbAssignmentStore, readVersion } from '../../src/index.js';
import { bootDb, DB_KINDS, rawQuery, TestDb } from '../support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AT = new Date('2026-10-01T12:00:00.000Z');
const BEFORE = new Date(AT.getTime() - 1000);
const AFTER = new Date(AT.getTime() + 1000);
const CREATED = new Date('2026-09-30T08:15:30.250Z');

const O1: ResourceRef = { type: 'org', id: 'o1' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const F1: ResourceRef = { type: 'file', id: 'f1' };

const alice: PrincipalRef = { type: 'user', id: 'alice' };
const bob: PrincipalRef = { type: 'user', id: 'bob' };
const carol: PrincipalRef = { type: 'user', id: 'carol' };
const g1: PrincipalRef = { type: 'group', id: 'g1' };
const root: PrincipalRef = { type: 'user', id: 'root' };
const g1Members: AssignmentSubject = { set: { role: 'group.member', scope: { type: 'group', id: 'g1' } } };
const o1Members: AssignmentSubject = { set: { role: 'org.member', scope: O1 } };

class FixedClock extends AuthzClock {
  now(): Date {
    return CREATED;
  }
}

type Row = Record<string, unknown>;

const row = (over: Row = {}): Row => ({ id: 'a1', subject_type: 'user', subject_id: 'alice', subject_role: '', role: 'editor', scope_type: 'project', scope_id: 'p1', tags: '', expires_at: null, granted_by: null, source: 'db', created_at: CREATED, ...over });

const byId = (items: readonly Assignment[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));

for (const kind of DB_KINDS) {
  describe(`DbAssignmentStore (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let store: DbAssignmentStore;

    const inTx = <R>(fn: (tx: AuthzTx) => Promise<R>): Promise<R> => db.driver.transaction((driver: OrmDriver) => fn({ driver }));

    const seed = async (...rows: Row[]) => {
      for (let i = 0; i < rows.length; i += 100) {
        await db.driver
          .insert()
          .into('authz_assignment')
          .values(rows.slice(i, i + 100));
      }
    };

    const rows = async (): Promise<Row[]> => (await db.driver.select().from('authz_assignment').orderBy('id')) as Row[];

    const version = (domain = 'root') => readVersion(db.driver, domain);

    /** Counts the SELECT statements `fn` sends on the default connection. */
    const countSelects = async <R>(fn: () => Promise<R>): Promise<{ result: R; selects: number }> => {
      const target = db.driver as unknown as { executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown> };
      const original = target.executeOnDb;
      let selects = 0;
      target.executeOnDb = function (stmt, params, context) {
        if (context === QueryContext.Select) selects++;
        return original.call(this, stmt, params, context);
      };
      try {
        return { result: await fn(), selects };
      } finally {
        target.executeOnDb = original;
      }
    };

    before(async function () {
      db = await bootDb(this, kind, 'assign_store', { second: true });
      await new AuthzRbac_2026_10_01_00_00_00().up(db.second!);
      db.container.register(FixedClock).as(AuthzClock);
      store = db.container.resolve(DbAssignmentStore);
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await rawQuery(db.driver, 'DELETE FROM authz_assignment', [], QueryContext.Delete);
      await rawQuery(db.driver, 'DELETE FROM authz_version', [], QueryContext.Delete);
      await rawQuery(db.second!, 'DELETE FROM authz_assignment', [], QueryContext.Delete);
      await rawQuery(db.second!, 'DELETE FROM authz_version', [], QueryContext.Delete);
    });

    describe('registration', () => {
      it('is an AdminAssignmentStore named DbAssignmentStore, registered by that name only', () => {
        expect(store).to.be.instanceOf(AdminAssignmentStore);
        expect(store).to.be.instanceOf(AssignmentStore);
        expect(store.name).to.eq('DbAssignmentStore');
        expect(db.container.resolve('DbAssignmentStore')).to.be.instanceOf(DbAssignmentStore);
        expect(DI.RootContainer.hasRegistered(AssignmentStore)).to.eq(false);
        expect(DI.RootContainer.hasRegistered(AdminAssignmentStore)).to.eq(false);
      });

      it('serves both ports with one instance per container when a domain registers it under them', () => {
        const child = db.container.child();
        child.register(DbAssignmentStore).as(AdminAssignmentStore);
        child.register(DbAssignmentStore).as(AssignmentStore);
        const admin = child.resolve(AdminAssignmentStore);
        expect(admin).to.be.instanceOf(DbAssignmentStore);
        expect(child.resolve(AssignmentStore)).to.eq(admin);
        expect(child.resolve(DbAssignmentStore)).to.eq(admin);
      });
    });

    describe('forSubjects', () => {
      it('returns the live assignments of principals, decoded', async () => {
        await seed(row({ id: 'a1', tags: ',a,b,', expires_at: AFTER, granted_by: 'user:root' }), row({ id: 'a2', subject_id: 'bob', role: 'viewer', scope_type: '$global', scope_id: '' }), row({ id: 'a3', subject_id: 'carol' }), row({ id: 'a4', subject_type: 'service', subject_id: 'alice' }));

        const found = byId(await store.forSubjects([alice, bob], AT));

        expect(found).to.deep.eq([
          { id: 'a1', subject: alice, role: 'editor', scope: P1, tags: ['a', 'b'], expiresAt: AFTER, grantedBy: root, source: 'db' },
          { id: 'a2', subject: bob, role: 'viewer', scope: GLOBAL, expiresAt: null, source: 'db' },
        ]);
        expect(found[0].expiresAt).to.be.instanceOf(Date);
      });

      it('returns subject-set assignments by their (scope type, scope id, role) triple', async () => {
        await seed(row({ id: 's1', subject_type: 'group', subject_id: 'g1', subject_role: 'group.member', role: 'viewer' }), row({ id: 's2', subject_type: 'group', subject_id: 'g1', subject_role: '', role: 'editor' }), row({ id: 's3', subject_type: 'group', subject_id: 'g1', subject_role: 'group.admin', role: 'editor' }), row({ id: 's4', subject_type: 'org', subject_id: 'o1', subject_role: 'org.member', role: 'viewer', scope_id: 'p2' }));

        const found = byId(await store.forSubjects([g1Members, o1Members], AT));

        expect(found.map((a) => a.id)).to.deep.eq(['s1', 's4']);
        expect(found[0].subject).to.deep.eq(g1Members);
        expect(found[1]).to.deep.eq({ id: 's4', subject: o1Members, role: 'viewer', scope: P2, expiresAt: null, source: 'db' });

        expect((await store.forSubjects([g1], AT)).map((a) => a.id)).to.deep.eq(['s2']);
      });

      it('takes principals and subject sets together', async () => {
        await seed(row({ id: 'm1' }), row({ id: 'm2', subject_type: 'group', subject_id: 'g1', subject_role: 'group.member' }), row({ id: 'm3', subject_id: 'bob' }));

        const found = await store.forSubjects([alice, g1Members], AT);

        expect(found.map((a) => a.id).sort()).to.deep.eq(['m1', 'm2']);
      });

      it('leaves out expired rows and rows that expire exactly at `at`', async () => {
        await seed(row({ id: 'e1', expires_at: BEFORE }), row({ id: 'e2', role: 'viewer', expires_at: AT }), row({ id: 'e3', role: 'owner', expires_at: AFTER }), row({ id: 'e4', role: 'admin' }));

        const found = await store.forSubjects([alice], AT);

        expect(found.map((a) => a.id).sort()).to.deep.eq(['e3', 'e4']);
      });

      it('answers an empty subject list with [] and no query', async () => {
        class NoDb extends DbAssignmentStore {
          protected override connection(): Promise<OrmDriver> {
            throw new Error('no query expected');
          }
        }

        expect(await new NoDb(db.container).forSubjects([], AT)).to.deep.eq([]);
      });

      it('answers 1,500 subjects (batched under the parameter limits)', async () => {
        const many = Array.from({ length: 1500 }, (_, i) => ({ type: 'user', id: `u${i}` }));
        await seed(...many.map((p, i) => row({ id: `b${String(i).padStart(4, '0')}`, subject_id: p.id })), row({ id: 'zz', subject_id: 'other' }));

        const { result: found, selects } = await countSelects(() => store.forSubjects([...many, ...many.slice(0, 10)], AT));

        expect(found).to.have.length(1500);
        expect(new Set(found.map((a) => a.id)).size).to.eq(1500);
        expect(selects, 'one query per 250 subjects').to.eq(6);
      });

      it('loses and repeats nothing across batch boundaries', async () => {
        class SmallBatches extends DbAssignmentStore {
          protected override readonly subjectBatch = 3;
        }
        const users = Array.from({ length: 8 }, (_, i) => ({ type: 'user', id: `u${i}` }));
        const sets = Array.from({ length: 4 }, (_, i): AssignmentSubject => ({ set: { role: 'group.member', scope: { type: 'group', id: `g${i}` } } }));
        await seed(...users.map((p) => row({ id: `p-${p.id}`, subject_id: p.id })), ...sets.map((_, i) => row({ id: `s-g${i}`, subject_type: 'group', subject_id: `g${i}`, subject_role: 'group.member' })));

        const subjects = [...users.slice(0, 4), ...sets, ...users.slice(4), users[0], sets[1]];
        const { result: found, selects } = await countSelects(() => new SmallBatches(db.container).forSubjects(subjects, AT));

        expect(found.map((a) => a.id).sort()).to.deep.eq([...users.map((p) => `p-${p.id}`), ...sets.map((_, i) => `s-g${i}`)].sort());
        expect(selects, '12 distinct subjects in batches of 3').to.eq(4);
      });
    });

    describe('holders', () => {
      it('returns the live subjects holding exactly that role at exactly that scope', async () => {
        await seed(row({ id: 'h1' }), row({ id: 'h2', subject_type: 'group', subject_id: 'g1', subject_role: 'group.member' }), row({ id: 'h3', subject_id: 'bob', role: 'viewer' }), row({ id: 'h4', subject_id: 'carol', scope_id: 'p2' }), row({ id: 'h5', subject_id: 'dora', scope_type: 'file', scope_id: 'f1' }), row({ id: 'h6', subject_id: 'erin', expires_at: AT }), row({ id: 'h7', subject_id: 'fred', expires_at: AFTER }), row({ id: 'h8', subject_id: 'gina', scope_type: '$global', scope_id: '' }));

        const holders = await store.holders('editor', P1, AT);
        const keys = holders.map((s) => JSON.stringify(s)).sort();

        expect(keys).to.deep.eq([alice, g1Members, { type: 'user', id: 'fred' }].map((s) => JSON.stringify(s)).sort());
        expect(await store.holders('editor', GLOBAL, AT)).to.deep.eq([{ type: 'user', id: 'gina' }]);
        expect(await store.holders('editor', F1, AT)).to.deep.eq([{ type: 'user', id: 'dora' }]);
        expect(await store.holders('ghost', P1, AT)).to.deep.eq([]);
      });
    });

    describe('byId', () => {
      it('returns live and expired rows, and null for an unknown id', async () => {
        await seed(row({ id: 'live' }), row({ id: 'old', role: 'viewer', expires_at: BEFORE }));

        expect(await store.byId('live')).to.deep.eq({ id: 'live', subject: alice, role: 'editor', scope: P1, expiresAt: null, source: 'db' });
        expect(await store.byId('old')).to.deep.include({ id: 'old', expiresAt: BEFORE });
        expect(await store.byId('missing')).to.eq(null);
      });
    });

    describe('assign', () => {
      it('writes the row and returns the assignment', async () => {
        const a = await inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1, tags: ['b', 'a', 'a'], expiresAt: AFTER }, root, tx));

        expect(a.id).to.match(UUID);
        expect(a).to.deep.eq({ id: a.id, subject: alice, role: 'editor', scope: P1, tags: ['a', 'b'], expiresAt: AFTER, grantedBy: root, source: 'db' });

        const [r] = await rows();
        expect(r).to.deep.include({ id: a.id, subject_type: 'user', subject_id: 'alice', subject_role: '', role: 'editor', scope_type: 'project', scope_id: 'p1', tags: ',a,b,', granted_by: 'user:root', source: 'db' });
        expect(await store.byId(a.id)).to.deep.eq(a);
        expect((await store.byId(a.id))!.expiresAt!.getTime()).to.eq(AFTER.getTime());
      });

      it('takes created_at from AuthzClock', async () => {
        const a = await inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1 }, root, tx));

        const [r] = (await db.driver.select().from('authz_assignment').where('id', a.id).where('created_at', CREATED)) as Row[];
        expect(r, 'row with created_at = clock now').to.not.be.undefined;
      });

      it('writes subject sets and GLOBAL as their columns', async () => {
        const a = await inTx((tx) => store.assign({ subject: g1Members, role: 'viewer', scope: GLOBAL }, root, tx));

        expect(a.subject).to.deep.eq(g1Members);
        expect(a.scope).to.deep.eq(GLOBAL);
        expect(a).to.not.have.property('tags');
        expect(a.expiresAt).to.eq(null);
        expect((await rows())[0]).to.deep.include({ subject_type: 'group', subject_id: 'g1', subject_role: 'group.member', scope_type: '$global', scope_id: '', tags: '' });
      });

      it('refuses an empty tag or a tag holding the separator, naming it', async () => {
        await expect(inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1, tags: ['ok', ''] }, root, tx))).to.be.rejectedWith(AuthzAdminFailure, /""/);
        await expect(inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1, tags: ['a,b'] }, root, tx))).to.be.rejectedWith(AuthzAdminFailure, /"a,b"/);
        expect(await rows()).to.deep.eq([]);
      });

      it('keeps % and _ in tags', async () => {
        const a = await inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1, tags: ['50%', 'a_b'] }, root, tx));

        expect(a.tags).to.deep.eq(['50%', 'a_b']);
        expect((await rows())[0].tags).to.eq(',50%,a_b,');
      });

      it('creates the version row at 1 and bumps it by one per call', async () => {
        expect(await version()).to.eq('0');

        await inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1 }, root, tx));
        expect(await version()).to.eq('1');

        await inTx(async (tx) => {
          await store.assign({ subject: bob, role: 'editor', scope: P1 }, root, tx);
          await store.assign({ subject: carol, role: 'editor', scope: P1 }, root, tx);
        });
        expect(await version()).to.eq('3');
      });

      it('updates tags and expiry of an existing (subject, role, scope) grant and keeps its id', async () => {
        const first = await inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1, tags: ['a'], expiresAt: AFTER }, root, tx));
        const again = await inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1, tags: ['c'] }, bob, tx));

        expect(again).to.deep.eq({ id: first.id, subject: alice, role: 'editor', scope: P1, tags: ['c'], expiresAt: null, grantedBy: bob, source: 'db' });
        expect(await rows()).to.have.length(1);
        expect(await version()).to.eq('2');
      });

      it('a second grant keeps created_at and source and revives an expired row', async () => {
        const OLD = new Date('2020-01-02T03:04:05.000Z');
        await seed(row({ id: 'old', source: 'migration', created_at: OLD, expires_at: BEFORE }));

        const again = await inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1 }, root, tx));

        expect(again).to.deep.eq({ id: 'old', subject: alice, role: 'editor', scope: P1, expiresAt: null, grantedBy: root, source: 'migration' });
        expect((await store.forSubjects([alice], AT)).map((a) => a.id)).to.deep.eq(['old']);
        const [r] = (await db.driver.select().from('authz_assignment').where('id', 'old').where('created_at', OLD)) as Row[];
        expect(r, 'created_at kept').to.not.be.undefined;
      });

      it('reports a duplicate first grant (a concurrent insert) as conflict', async () => {
        class Blind extends DbAssignmentStore {
          protected override existingRow(): Promise<undefined> {
            return Promise.resolve(undefined);
          }
        }
        await seed(row({ id: 'taken' }));

        const err = await inTx((tx) => new Blind(db.container).assign({ subject: alice, role: 'editor', scope: P1 }, root, tx)).catch((e) => e);

        expect(err).to.be.instanceOf(AuthzAdminFailure);
        expect((err as AuthzAdminFailure).code).to.eq('conflict');
        expect((await rows()).map((r) => r.id)).to.deep.eq(['taken']);
      });

      if (kind === 'postgres') {
        it('reports a grant that races another transaction as conflict', async () => {
          let release!: () => void;
          const gate = new Promise<void>((r) => (release = r));
          let inserted!: () => void;
          const firstInserted = new Promise<void>((r) => (inserted = r));

          const first = inTx(async (tx) => {
            await store.assign({ subject: alice, role: 'editor', scope: P1 }, root, tx);
            inserted();
            await gate;
          });
          await firstInserted;

          // The second insert waits on the first transaction's uncommitted key.
          const second = inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1 }, bob, tx)).catch((e) => e);
          await new Promise((r) => setTimeout(r, 300));
          release();

          await first;
          const err = await second;
          expect(err).to.be.instanceOf(AuthzAdminFailure);
          expect((err as AuthzAdminFailure).code).to.eq('conflict');
          expect(await rows()).to.have.length(1);
          expect(await version()).to.eq('1');
        });
      }

      it('refuses a transaction on another connection than the store reads (D-L2-2)', async () => {
        const other = (fn: (tx: AuthzTx) => Promise<unknown>) => db.second!.transaction((driver: OrmDriver) => fn({ driver }));
        await seed(row({ id: 'w1' }));

        await expect(other((tx) => store.assign({ subject: alice, role: 'viewer', scope: P1 }, root, tx))).to.be.rejectedWith(AuthzConfigError, /l2-assign_store-second/);
        await expect(other((tx) => store.revokeWhere({ scope: P1 }, tx))).to.be.rejectedWith(AuthzConfigError, /connection/);
        await expect(other((tx) => store.forgetScope(P1, tx))).to.be.rejectedWith(AuthzConfigError, /connection/);
        await expect(other((tx) => store.setTags('w1', ['x'], tx))).to.be.rejectedWith(AuthzConfigError, /connection/);
        await expect(other((tx) => store.revokeSubjects([alice], tx))).to.be.rejectedWith(AuthzConfigError, /connection/);

        expect(await rawQuery(db.second!, 'SELECT id FROM authz_assignment')).to.deep.eq([]);
        expect(await rawQuery(db.second!, 'SELECT domain FROM authz_version')).to.deep.eq([]);
        expect((await rows()).map((r) => r.id)).to.deep.eq(['w1']);
      });

      describe('in an authz domain', () => {
        let domain: IContainer;

        // AuthzDomains.create reads the root Configuration; the test DB's lives in a child container.
        before(async () => {
          await testHost.installHost();
          domain = DI.resolve(AuthzDomains).create(`l2_t3_${kind}`);
        });

        after(async () => {
          await domain?.dispose();
          await testHost.uninstallHost();
        });

        it("bumps that domain's version, not root's", async () => {
          const driver = db.driver;
          class InDomain extends DbAssignmentStore {
            protected override connection(): Promise<OrmDriver> {
              return Promise.resolve(driver);
            }
          }

          await inTx((tx) => new InDomain(domain).assign({ subject: alice, role: 'editor', scope: P1 }, root, tx));

          expect(await version(`l2_t3_${kind}`)).to.eq('1');
          expect(await version('root')).to.eq('0');
        });
      });

      it('refuses to write outside a transaction', async () => {
        await expect(store.assign({ subject: alice, role: 'editor', scope: P1 }, root, { driver: db.driver })).to.be.rejectedWith(/transaction/);
        await expect(store.assign({ subject: alice, role: 'editor', scope: P1 }, root, { driver: {} })).to.be.rejectedWith(/OrmDriver/);
        expect(await rows()).to.deep.eq([]);
        expect(await version()).to.eq('0');
      });

      it('rolls back the row and the version bump with the surrounding transaction (B27 store part)', async () => {
        await expect(
          inTx(async (tx) => {
            await store.assign({ subject: alice, role: 'editor', scope: P1 }, root, tx);
            throw new Error('abort');
          }),
        ).to.be.rejectedWith('abort');

        expect(await rows()).to.deep.eq([]);
        expect(await version()).to.eq('0');
      });

      it('compares expiry correctly in a zone far from UTC', async () => {
        const tz = process.env.TZ;
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const offset = AT.getTimezoneOffset();
        process.env.TZ = 'Asia/Kolkata';

        try {
          expect(AT.getTimezoneOffset(), 'the zone switch took effect').to.eq(-330);
          const live = await inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1, expiresAt: AFTER }, root, tx));
          await inTx((tx) => store.assign({ subject: alice, role: 'viewer', scope: P1, expiresAt: AT }, root, tx));

          expect((await store.forSubjects([alice], AT)).map((a) => a.id)).to.deep.eq([live.id]);
          expect((await store.byId(live.id))!.expiresAt!.getTime()).to.eq(AFTER.getTime());
        } finally {
          // Deleting TZ alone keeps Node in the last zone; setting it back first resets it.
          process.env.TZ = tz ?? zone;
          if (tz === undefined) delete process.env.TZ;
        }
        expect(AT.getTimezoneOffset(), 'the zone is restored').to.eq(offset);
      });
    });

    describe('revoke', () => {
      it('deletes the row and bumps the version', async () => {
        await seed(row({ id: 'r1' }), row({ id: 'r2', subject_id: 'bob' }));

        await inTx((tx) => store.revoke('r1', root, tx));

        expect((await rows()).map((r) => r.id)).to.deep.eq(['r2']);
        expect(await version()).to.eq('1');
      });

      it('refuses an unknown id with not_found', async () => {
        const err = await inTx((tx) => store.revoke('missing', root, tx)).catch((e) => e);

        expect(err).to.be.instanceOf(AuthzAdminFailure);
        expect((err as AuthzAdminFailure).code).to.eq('not_found');
      });

      it('refuses to write outside a transaction', async () => {
        await seed(row({ id: 'r1' }));

        await expect(store.revoke('r1', root, { driver: db.driver })).to.be.rejectedWith(/transaction/);
        expect(await rows()).to.have.length(1);
      });
    });

    describe('tags and expiry', () => {
      beforeEach(async () => {
        await seed(row({ id: 't1', tags: ',a,b,' }));
      });

      it('setTags replaces the tags', async () => {
        const a = await inTx((tx) => store.setTags('t1', ['z', 'c', 'z'], tx));

        expect(a.tags).to.deep.eq(['c', 'z']);
        expect((await rows())[0].tags).to.eq(',c,z,');
        expect(await version()).to.eq('1');
      });

      it('setTags to none stores the empty text', async () => {
        const a = await inTx((tx) => store.setTags('t1', [], tx));

        expect(a).to.not.have.property('tags');
        expect((await rows())[0].tags).to.eq('');
      });

      it('addTags merges', async () => {
        const a = await inTx((tx) => store.addTags('t1', ['c', 'a'], tx));

        expect(a.tags).to.deep.eq(['a', 'b', 'c']);
        expect(await version()).to.eq('1');
      });

      it('removeTags removes', async () => {
        const a = await inTx((tx) => store.removeTags('t1', ['a', 'x'], tx));

        expect(a.tags).to.deep.eq(['b']);
        expect((await rows())[0].tags).to.eq(',b,');
        expect(await version()).to.eq('1');
      });

      it('refuses invalid tags', async () => {
        await expect(inTx((tx) => store.addTags('t1', ['x,y'], tx))).to.be.rejectedWith(AuthzAdminFailure, /"x,y"/);
        expect((await rows())[0].tags).to.eq(',a,b,');
      });

      it('setExpiry sets and clears the expiry', async () => {
        const set = await inTx((tx) => store.setExpiry('t1', AFTER, tx));
        expect(set.expiresAt).to.deep.eq(AFTER);
        expect((await store.byId('t1'))!.expiresAt).to.deep.eq(AFTER);

        const cleared = await inTx((tx) => store.setExpiry('t1', null, tx));
        expect(cleared.expiresAt).to.eq(null);
        expect(await version()).to.eq('2');
      });

      it('refuses an unknown id with not_found', async () => {
        for (const call of [(tx: AuthzTx) => store.setTags('missing', ['a'], tx), (tx: AuthzTx) => store.addTags('missing', ['a'], tx), (tx: AuthzTx) => store.removeTags('missing', ['a'], tx), (tx: AuthzTx) => store.setExpiry('missing', null, tx)]) {
          const err = await inTx(call).catch((e) => e);
          expect(err).to.be.instanceOf(AuthzAdminFailure);
          expect((err as AuthzAdminFailure).code).to.eq('not_found');
        }
      });

      it('refuse to write outside a transaction', async () => {
        await expect(store.setTags('t1', ['x'], { driver: db.driver })).to.be.rejectedWith(/transaction/);
        await expect(store.addTags('t1', ['x'], { driver: db.driver })).to.be.rejectedWith(/transaction/);
        await expect(store.removeTags('t1', ['a'], { driver: db.driver })).to.be.rejectedWith(/transaction/);
        await expect(store.setExpiry('t1', null, { driver: db.driver })).to.be.rejectedWith(/transaction/);
        expect((await rows())[0].tags).to.eq(',a,b,');
      });
    });

    describe('AdminAssignmentStore port', () => {
      beforeEach(async () => {
        await seed(row({ id: 't1', tags: ',a,b,', expires_at: AFTER, created_at: new Date(CREATED.getTime() - 1000) }), row({ id: 't2', subject_id: 'bob', expires_at: BEFORE }), row({ id: 't3', role: 'viewer', scope_id: 'p2', created_at: new Date(CREATED.getTime() + 1000) }));
      });

      it('update writes the tags and the expiry given, keeps the rest, and bumps once', async () => {
        const both = await inTx((tx) => store.update('t1', { tags: ['z', 'c'], expiresAt: null }, root, tx));
        expect(both).to.deep.include({ id: 't1', tags: ['c', 'z'], expiresAt: null });
        expect(await version()).to.eq('1');

        const tagsOnly = await inTx((tx) => store.update('t1', { tags: [] }, root, tx));
        expect(tagsOnly).to.not.have.property('tags');
        expect(tagsOnly.expiresAt).to.eq(null);
        const expiryOnly = await inTx((tx) => store.update('t1', { expiresAt: AFTER }, root, tx));
        expect(expiryOnly.expiresAt).to.deep.eq(AFTER);
        expect((await store.byId('t1'))!).to.deep.include({ expiresAt: AFTER });
        expect((await rows())[0].tags).to.eq('');
        expect(await version()).to.eq('3');
      });

      it('update refuses an unknown id, bad tags and a write outside a transaction, writing nothing', async () => {
        const missing = await inTx((tx) => store.update('missing', { tags: ['a'] }, root, tx)).catch((e) => e);
        expect(missing).to.be.instanceOf(AuthzAdminFailure);
        expect((missing as AuthzAdminFailure).code).to.eq('not_found');
        await expect(inTx((tx) => store.update('t1', { tags: ['x,y'] }, root, tx))).to.be.rejectedWith(AuthzAdminFailure, /"x,y"/);
        await expect(store.update('t1', { tags: ['x'] }, root, { driver: db.driver })).to.be.rejectedWith(AuthzConfigError, /transaction/);
        expect((await rows())[0].tags).to.eq(',a,b,');
        expect(await version()).to.eq('0');
      });

      it('find filters as list does, reads q.at as now and takes the page as a second argument', async () => {
        expect((await store.find({ at: AT })).items.map((a) => a.id)).to.deep.eq(['t1', 't3']);
        expect((await store.find({ at: AT, includeExpired: true })).total).to.eq(3);
        expect((await store.find({ at: new Date(BEFORE.getTime() - 1) })).items.map((a) => a.id)).to.deep.eq(['t1', 't2', 't3']);
        expect((await store.find({ at: AT, scope: P1, subject: alice })).items.map((a) => a.id)).to.deep.eq(['t1']);
        expect(await store.find({ at: AT, includeExpired: true }, { limit: 1, offset: 1 })).to.deep.include({ total: 3 });
        expect((await store.find({ at: AT, includeExpired: true }, { limit: 1, offset: 1 })).items.map((a) => a.id)).to.deep.eq(['t2']);
        await expect(store.find({ at: AT }, { limit: -1, offset: 0 })).to.be.rejectedWith(AuthzAdminFailure, /page/);
      });
    });

    describe('revokeWhere and forgetScope', () => {
      beforeEach(async () => {
        await seed(row({ id: 'w1' }), row({ id: 'w2', role: 'viewer' }), row({ id: 'w3', subject_id: 'bob' }), row({ id: 'w4', subject_type: 'group', subject_id: 'g1', subject_role: 'group.member' }), row({ id: 'w5', scope_id: 'p2' }), row({ id: 'w6', scope_type: 'file', scope_id: 'f1' }), row({ id: 'w7', subject_id: 'bob', role: 'owner', expires_at: BEFORE }));
      });

      it('revokeWhere deletes the rows at the scope that match subject and role, and returns them', async () => {
        const gone = await inTx((tx) => store.revokeWhere({ scope: P1, subject: alice, role: 'editor' }, tx));

        expect(gone.map((a) => a.id)).to.deep.eq(['w1']);
        expect((await rows()).map((r) => r.id)).to.deep.eq(['w2', 'w3', 'w4', 'w5', 'w6', 'w7']);
        expect(await version()).to.eq('1');
      });

      it('revokeWhere by subject (a set), by role alone, and on expired rows', async () => {
        expect((await inTx((tx) => store.revokeWhere({ scope: P1, subject: g1Members }, tx))).map((a) => a.id)).to.deep.eq(['w4']);
        expect((await inTx((tx) => store.revokeWhere({ scope: P1, role: 'editor' }, tx))).map((a) => a.id).sort()).to.deep.eq(['w1', 'w3']);
        expect((await inTx((tx) => store.revokeWhere({ scope: P1, role: 'owner' }, tx))).map((a) => a.id)).to.deep.eq(['w7']);
        expect((await rows()).map((r) => r.id)).to.deep.eq(['w2', 'w5', 'w6']);
        expect(await version()).to.eq('3');
      });

      it('revokeWhere matching nothing returns [] and still bumps once', async () => {
        expect(await inTx((tx) => store.revokeWhere({ scope: P2, role: 'ghost' }, tx))).to.deep.eq([]);
        expect(await rows()).to.have.length(7);
        expect(await version()).to.eq('1');
      });

      it('forgetScope deletes every row at the scope, expired too, and nothing below it', async () => {
        const gone = await inTx((tx) => store.forgetScope(P1, tx));

        expect(gone.map((a) => a.id).sort()).to.deep.eq(['w1', 'w2', 'w3', 'w4', 'w7']);
        expect((await rows()).map((r) => r.id)).to.deep.eq(['w5', 'w6']);
        expect(await version()).to.eq('1');
      });

      it('forgetScope also deletes grants to a subject set living at the scope, held anywhere', async () => {
        await seed(row({ id: 'x1', subject_type: 'project', subject_id: 'p1', subject_role: 'project.member', role: 'viewer', scope_id: 'p2' }), row({ id: 'x2', subject_type: 'project', subject_id: 'p1', subject_role: 'project.admin', role: 'owner', scope_type: '$global', scope_id: '', expires_at: BEFORE }), row({ id: 'x3', subject_type: 'project', subject_id: 'p1', subject_role: '', role: 'viewer', scope_id: 'p2' }), row({ id: 'x4', subject_type: 'project', subject_id: 'p2', subject_role: 'project.member', role: 'viewer', scope_type: 'file', scope_id: 'f1' }));

        const gone = await inTx((tx) => store.forgetScope(P1, tx));

        expect(gone.map((a) => a.id).sort()).to.deep.eq(['w1', 'w2', 'w3', 'w4', 'w7', 'x1', 'x2']);
        expect(gone.find((a) => a.id === 'x1')!.subject).to.deep.eq({ set: { role: 'project.member', scope: P1 } });
        expect((await rows()).map((r) => r.id)).to.deep.eq(['w5', 'w6', 'x3', 'x4']);
        expect(await version()).to.eq('1');
      });

      it('forgetScope refuses GLOBAL and type-level refs', async () => {
        for (const scope of [GLOBAL, { type: 'project' }]) {
          const err = await inTx((tx) => store.forgetScope(scope, tx)).catch((e) => e);
          expect(err, JSON.stringify(scope)).to.be.instanceOf(AuthzAdminFailure);
          expect((err as AuthzAdminFailure).code).to.eq('wrong_scope_type');
          expect((err as AuthzAdminFailure).field).to.eq('scope');
        }
        expect(await rows()).to.have.length(7);
        expect(await version()).to.eq('0');
      });

      it('revokeSubjects deletes every row of the subjects at any scope, expired too, with one bump', async () => {
        const gone = await inTx((tx) => store.revokeSubjects([bob, g1Members, bob], tx));

        expect(gone.map((a) => a.id).sort()).to.deep.eq(['w3', 'w4', 'w7']);
        expect((await rows()).map((r) => r.id)).to.deep.eq(['w1', 'w2', 'w5', 'w6']);
        expect(await version()).to.eq('1');
      });

      it('revokeSubjects batches the subjects', async () => {
        class Small extends DbAssignmentStore {
          protected readonly subjectBatch = 1;
        }
        const small = new Small(db.container);

        const gone = await inTx((tx) => small.revokeSubjects([alice, bob, g1Members], tx));

        expect(gone.map((a) => a.id).sort()).to.deep.eq(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']);
        expect(await rows()).to.deep.eq([]);
        expect(await version()).to.eq('1');
      });

      it('revokeSubjects with no subjects deletes nothing and still bumps once', async () => {
        expect(await inTx((tx) => store.revokeSubjects([], tx))).to.deep.eq([]);
        expect(await rows()).to.have.length(7);
        expect(await version()).to.eq('1');
      });

      it('refuse to write outside a transaction', async () => {
        await expect(store.revokeWhere({ scope: P1 }, { driver: db.driver })).to.be.rejectedWith(/transaction/);
        await expect(store.forgetScope(P1, { driver: db.driver })).to.be.rejectedWith(/transaction/);
        await expect(store.revokeSubjects([alice], { driver: db.driver })).to.be.rejectedWith(/transaction/);
        expect(await rows()).to.have.length(7);
      });
    });

    describe('list', () => {
      beforeEach(async () => {
        await seed(row({ id: 'l1', created_at: new Date(CREATED.getTime() + 1) }), row({ id: 'l2', role: 'viewer', created_at: new Date(CREATED.getTime() + 2) }), row({ id: 'l3', subject_id: 'bob', created_at: new Date(CREATED.getTime() + 3) }), row({ id: 'l4', subject_type: 'group', subject_id: 'g1', subject_role: 'group.member', created_at: new Date(CREATED.getTime() + 4) }), row({ id: 'l5', scope_id: 'p2', created_at: new Date(CREATED.getTime() + 5) }), row({ id: 'l6', subject_id: 'bob', role: 'owner', expires_at: BEFORE, created_at: new Date(CREATED.getTime() + 6) }));
      });

      it('filters by scope, subject and role, live rows only by default', async () => {
        expect((await store.list({ scope: P1 }, AT)).items.map((a) => a.id)).to.deep.eq(['l1', 'l2', 'l3', 'l4']);
        expect((await store.list({ subject: bob }, AT)).items.map((a) => a.id)).to.deep.eq(['l3']);
        expect((await store.list({ subject: g1Members }, AT)).items.map((a) => a.id)).to.deep.eq(['l4']);
        expect((await store.list({ role: 'editor' }, AT)).items.map((a) => a.id)).to.deep.eq(['l1', 'l3', 'l4', 'l5']);
        expect((await store.list({ scope: P1, subject: alice, role: 'viewer' }, AT)).items.map((a) => a.id)).to.deep.eq(['l2']);
      });

      it('includes expired rows on request', async () => {
        const res = await store.list({ subject: bob, includeExpired: true }, AT);

        expect(res.items.map((a) => a.id)).to.deep.eq(['l3', 'l6']);
        expect(res.total).to.eq(2);
      });

      it('pages, with the total of the unpaged result', async () => {
        const res = await store.list({ scope: P1, page: { limit: 2, offset: 1 } }, AT);

        expect(res.items.map((a) => a.id)).to.deep.eq(['l2', 'l3']);
        expect(res.total).to.eq(4);
        expect(typeof res.total).to.eq('number');
      });

      it('refuses a negative or fractional limit or offset', async () => {
        for (const page of [
          { limit: -1, offset: 0 },
          { limit: 2, offset: -1 },
          { limit: 1.5, offset: 0 },
          { limit: 2, offset: Number.NaN },
        ]) {
          const err = await store.list({ scope: P1, page }, AT).catch((e) => e);
          expect(err, JSON.stringify(page)).to.be.instanceOf(AuthzAdminFailure);
          expect((err as AuthzAdminFailure).code).to.eq('invalid_page');
          expect((err as AuthzAdminFailure).field).to.eq('page');
        }
      });

      it(`caps the page at ${ASSIGNMENT_LIST_MAX_LIMIT} rows, with or without a page`, async () => {
        expect(ASSIGNMENT_LIST_MAX_LIMIT).to.eq(1000);

        class Capped extends DbAssignmentStore {
          protected override readonly maxListLimit = 2;
        }
        const capped = new Capped(db.container);

        const big = await capped.list({ scope: P1, page: { limit: 50, offset: 1 } }, AT);
        expect(big.items.map((a) => a.id)).to.deep.eq(['l2', 'l3']);
        expect(big.total).to.eq(4);

        const all = await capped.list({ scope: P1 }, AT);
        expect(all.items.map((a) => a.id)).to.deep.eq(['l1', 'l2']);
        expect(all.total).to.eq(4);
      });

      it('find without a page returns every match in one query; with a page it is capped', async () => {
        class Capped extends DbAssignmentStore {
          protected override readonly maxListLimit = 2;
        }
        const capped = new Capped(db.container);

        const { result, selects } = await countSelects(() => capped.find({ at: AT, scope: P1 }));
        expect(result.items.map((a) => a.id)).to.deep.eq(['l1', 'l2', 'l3', 'l4']);
        expect(result.total).to.eq(4);
        expect(selects).to.eq(1);

        const paged = await capped.find({ at: AT, scope: P1 }, { limit: 50, offset: 0 });
        expect(paged.items.map((a) => a.id)).to.deep.eq(['l1', 'l2']);
        expect(paged.total).to.eq(4);
      });
    });
  });
}
