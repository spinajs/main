import * as chai from 'chai';
import 'mocha';

import { ScopeForgetter, changeLog } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { HistoricalTupleSource, HistoryContributors, ReplayHistory } from '@spinajs/authz-ir';
import type { ObjectRef, PolicyIR, TupleSubjectRef } from '@spinajs/authz-ir';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource, HorizonRecord, Owner, Parent, Relation, Self, changeLogPrecisionMs, columnFingerprint, ormToIR, recordCoverage } from '../../src/index.js';
import { ColumnHistoryContributor } from '../../src/replay/index.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

const expect = chai.expect;

type M = typeof ModelBase & { insert(v: object | object[]): Promise<unknown>; update(v: object): { where(...a: unknown[]): Promise<unknown> }; destroy(pk: unknown): Promise<unknown> };

class NoopForgetter extends ScopeForgetter {
  async forget(_scope: ResourceRef, _ctx: AdminContext, _tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return { affected: 0, tags: [], events: [] };
  }
}

interface IdType {
  readonly name: string;
  readonly sql: (d: Dialect) => string;
  /** The ids of d1, d2, d3, f1, f2, s1, u1, u2, g1 as the column holds them. */
  readonly id: (n: number) => string | number;
}

const ID_TYPES: readonly IdType[] = [
  { name: 'string', sql: (d) => (d === 'mysql' ? 'VARCHAR(64)' : 'TEXT'), id: (n) => `k${n}` },
  { name: 'integer', sql: (d) => (d === 'mysql' ? 'INT' : 'INTEGER'), id: (n) => n },
  { name: 'bigint', sql: () => 'BIGINT', id: (n) => 2 ** 40 + n },
  { name: 'uuid', sql: (d) => (d === 'mysql' ? 'CHAR(36)' : d === 'sqlite' ? 'TEXT' : 'UUID'), id: (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` },
];

const WINDOW = { beforeMs: 60, afterMs: 60 };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ColumnHistoryContributor', function () {
  this.timeout(180000);
  let db: TestDb;
  const reachable = new Set<Dialect>(['sqlite', 'pglite']);
  const undo: (() => void)[] = [];

  before(async () => {
    if (await TestDb.postgresReachable()) reachable.add('postgres');
    if (await TestDb.mysqlReachable()) reachable.add('mysql');
    db = await TestDb.open({ postgres: reachable.has('postgres'), pglite: true, mysql: reachable.has('mysql') });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(ScopeForgetter, testHost.instance(new NoopForgetter())));
    await (await testHost.domains()).service('root');
  });

  afterEach(async () => {
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
  });

  it('is registered as a history contributor of the column kind', async () => {
    const all = DI.resolve(Array.ofType(HistoryContributors)).filter((c) => c instanceof ColumnHistoryContributor);
    expect(all).to.have.length(1);
    expect(all[0].kind).to.equal('column');
  });

  for (const dialect of ['sqlite', 'pglite', 'postgres', 'mysql'] as const) {
    describe(dialect, () => {
      before(function () {
        if (!reachable.has(dialect)) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      for (const t of ID_TYPES) {
        it(`rebuilds every relation column of ${t.name} ids at T, null and absent kept apart, without a gap`, async () => {
          const sql = t.sql(dialect);
          const text = dialect === 'mysql' ? 'VARCHAR(64)' : 'TEXT';
          const Doc = (await db.define(
            {
              name: 'Doc',
              columns: { id: sql, folder_id: sql, space_id: sql, owner_id: sql, editor_id: sql, editor_type: text },
              decorate: (c, p) => {
                AccessResource('doc')(c);
                Parent('folder')(p, 'folder_id');
                Parent('space')(p, 'space_id');
                Owner()(p, 'owner_id');
                Relation('editor', { typeColumn: 'editor_type' })(p, 'editor_id');
              },
            },
            dialect,
          )) as M;
          const [d1, d2, d3, f1, f2, s1, u1, u2, g1] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(t.id);
          const key = (v: string | number) => String(v);
          await recordCoverage([], [{ type: 'doc', fingerprint: columnFingerprint('doc') }], [], new Date(Date.now() - 60_000));

          await Doc.insert({ id: d1, folder_id: f1, space_id: s1, owner_id: null, editor_id: g1, editor_type: 'group' });
          await Doc.insert({ id: d2, folder_id: f2, space_id: s1, owner_id: u1, editor_id: null, editor_type: null });
          // s1 → null before T and back after it: the links between those changes hold only if a put from null is an add.
          await Doc.update({ space_id: null }).where('id', d1);
          await pause(3 * WINDOW.beforeMs);
          const T = new Date();
          await pause(3 * WINDOW.afterMs);
          await Doc.update({ folder_id: f2, owner_id: u2, editor_id: null, editor_type: null }).where('id', d1);
          await Doc.update({ space_id: s1 }).where('id', d1);
          await Doc.destroy(d2);
          await Doc.insert({ id: d3, folder_id: f1, space_id: null, owner_id: u1, editor_id: null, editor_type: null });

          const ir: PolicyIR = { version: 1, types: { ...ormToIR({ classes: [Doc] }).at(0)?.types }, permissions: {}, caveats: {}, combine: { default: { algorithm: 'deny-overrides' } }, principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} }, opaque: [] };
          const contributor = new ColumnHistoryContributor();
          const history = await ReplayHistory.load(changeLog(), T, ['column'], { maxChanges: 1000, maxKeys: 1000, window: WINDOW, precisionMs: changeLogPrecisionMs(db.driver(dialect)) });
          const source = new HistoricalTupleSource(ir, T, [contributor], history);
          const read = async (id: string | number, relation: string): Promise<TupleSubjectRef[]> => {
            const out: TupleSubjectRef[] = [];
            for await (const s of source.read({ type: 'doc', id: key(id) }, relation)) out.push(s);
            return out;
          };
          const reverse = async (subject: TupleSubjectRef, relation: string): Promise<ObjectRef[]> => {
            const out: ObjectRef[] = [];
            for await (const o of source.reverse(subject, relation, 'doc')) out.push(o);
            return out;
          };

          expect(await read(d1, 'parent_folder_id')).to.deep.equal([{ type: 'folder', id: key(f1) }]);
          expect(await read(d1, 'parent_space_id')).to.deep.equal([]);
          expect(await read(d2, 'parent')).to.deep.equal([
            { type: 'folder', id: key(f2) },
            { type: 'space', id: key(s1) },
          ]);
          expect(await read(d1, 'owner')).to.deep.equal([]);
          expect(await read(d2, 'owner')).to.deep.equal([{ type: 'user', id: key(u1) }]);
          expect(await read(d1, 'editor')).to.deep.equal([{ type: 'group', id: key(g1) }]);
          expect(await read(d3, 'owner')).to.deep.equal([]);
          expect(await reverse({ type: 'user', id: key(u1) }, 'owner')).to.deep.equal([{ type: 'doc', id: key(d2) }]);
          expect(await reverse({ type: 'folder', id: key(f2) }, 'parent_folder_id')).to.deep.equal([{ type: 'doc', id: key(d2) }]);
          expect(source.reads.filter((r) => r.origin === 'gap')).to.deep.equal([]);
          expect(source.reads.filter((r) => r.origin === 'history').length).to.be.greaterThan(0);
        });
      }

      it('distrusts a coverage recorded for other relation columns or a model kept out of the changelog, and serves no @Self column', async () => {
        const Doc = await db.define({ name: 'Doc', columns: { folder_id: 'VARCHAR(64)', user_id: 'VARCHAR(64)' }, decorate: (c, p) => (AccessResource('doc')(c), Parent('folder')(p, 'folder_id'), Self()(p, 'user_id')) }, dialect);
        const contributor = new ColumnHistoryContributor();
        await recordCoverage([], [{ type: 'doc', fingerprint: columnFingerprint('doc') }], [], new Date(Date.now() - 60_000));
        expect(await contributor.coverageGap('doc')).to.equal(undefined);
        await HorizonRecord.update({ fingerprint: 'f'.repeat(64) }).where('kind', 'column').where('resource_type', 'doc');
        expect(await contributor.coverageGap('doc')).to.match(/other relation columns/);
        expect(contributor.serves({ kind: 'column', model: Doc.name, column: 'folder_id' })).to.equal(true);
        expect(contributor.serves({ kind: 'column', model: Doc.name, column: 'user_id' })).to.equal(false);
        // One @Parent column: an `ancestor via 'orm'` read of doc (an IR compiled when doc had several) has no parts now.
        expect(contributor.parts('doc', 'parent', { kind: 'ancestor', via: 'orm' })).to.deep.equal([]);
        expect(contributor.parts('doc', 'parent', { kind: 'column', model: Doc.name, column: 'folder_id' })).to.equal(undefined);
        await db.define({ name: 'Quiet', columns: { folder_id: 'VARCHAR(64)' }, decorate: (c, p) => (AccessResource('doc', { changelog: false })(c), Parent('folder')(p, 'folder_id')) }, dialect);
        expect(await contributor.coverageGap('doc')).to.match(/changelog: false/);
      });
    });
  }
});
