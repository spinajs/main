import * as chai from 'chai';
import 'mocha';
import { createHash, randomUUID } from 'node:crypto';

import { changeLog } from '@spinajs/authz';
import { HistoricalTupleSource, HistoryContributors, ReplayHistory } from '@spinajs/authz-ir';
import type { ObjectRef, PolicyIR, TupleSubjectRef } from '@spinajs/authz-ir';
import { recordCoverage } from '@spinajs/authz-orm/changelog';
import { DI } from '@spinajs/di';

import { DbTupleStore, TupleHistoryContributor, tupleKey } from '../src/index.js';
import type { Tuple } from '../src/index.js';
import { DIALECTS, bootDb } from './support/db.js';
import type { TestDb } from './support/db.js';

const expect = chai.expect;

const WINDOW = 100;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const source = { kind: 'tuples', store: 'authz_rebac_tuple' } as const;
const ADMIN = { type: 'user', id: 'admin' };

const IR: PolicyIR = {
  version: 1,
  types: {
    doc: { relations: { viewer: { allowed: ['user', 'user:*', 'group#member', { type: 'user', caveat: 'draft' }], source } }, permissions: {} },
    group: { relations: { member: { allowed: ['user'], source } }, permissions: {} },
  },
  permissions: {},
  caveats: { draft: { params: {}, expr: { attr: 'resource.status', eq: 'draft' } } },
  combine: { default: { algorithm: 'deny-overrides' } },
  principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} },
  opaque: [],
};

const viewer = (doc: string, subject: Tuple['subject']): Tuple => ({ object: { type: 'doc', id: doc }, relation: 'viewer', subject });
const user = (id: string) => ({ type: 'user', id });
const G1_MEMBERS = { object: { type: 'group', id: 'g1' }, relation: 'member' };
const label = (s: TupleSubjectRef | ObjectRef): string => `${s.type}:${s.id}${'relation' in s && s.relation !== undefined ? `#${s.relation}` : ''}`;

async function collect<T extends TupleSubjectRef | ObjectRef>(it: AsyncIterable<T>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of it) out.push(label(s));
  return out.sort();
}

async function sourceAt(at: Date): Promise<HistoricalTupleSource> {
  const history = await ReplayHistory.load(changeLog(), at, ['tuple'], { maxChanges: 1000, maxKeys: 1000, window: { beforeMs: WINDOW, afterMs: WINDOW } });
  return new HistoricalTupleSource(IR, at, [new TupleHistoryContributor()], history);
}

describe('TupleHistoryContributor', function () {
  this.timeout(180000);

  it('is registered as the history contributor of the tuple kind', () => {
    expect(DI.getRegisteredTypes(HistoryContributors)).to.include(TupleHistoryContributor);
    expect(new TupleHistoryContributor().serves(source)).to.equal(true);
    expect(new TupleHistoryContributor().serves({ kind: 'tuples', store: 'authz_assignment' })).to.equal(false);
  });

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      let db: TestDb;
      let store: DbTupleStore;

      before(async function () {
        db = await bootDb('tuple_replay', this, dialect);
        store = new DbTupleStore();
        await recordCoverage(['tuple'], [], [], new Date(Date.now() - 3_600_000));
      });

      after(async () => {
        await db?.dispose();
      });

      it('rebuilds relations at T from current rows and the changelog, removes matched by key, without a gap', async () => {
        const numeric = '42';
        const uuid = randomUUID();
        await store.write([viewer('d1', user('alice')), viewer('d1', G1_MEMBERS), viewer(numeric, user('bob')), viewer(uuid, user('*')), { object: { type: 'group', id: 'g1' }, relation: 'member', subject: user('alice') }], [], ADMIN);
        await store.write([viewer('d1', user('erin'))], [], ADMIN);
        await store.write([], [viewer('d1', user('erin'))], ADMIN);
        await pause(3 * WINDOW);
        const T = new Date();
        await pause(3 * WINDOW);

        const reads = async () => {
          const s = await sourceAt(T);
          const out = {
            d1: await collect(s.read({ type: 'doc', id: 'd1' }, 'viewer')),
            numeric: await collect(s.read({ type: 'doc', id: numeric }, 'viewer')),
            uuid: await collect(s.read({ type: 'doc', id: uuid }, 'viewer')),
            g1: await collect(s.read({ type: 'group', id: 'g1' }, 'member')),
            alice: await collect(s.reverse(user('alice'), 'viewer', 'doc')),
            set: await collect(s.reverse({ type: 'group', id: 'g1', relation: 'member' }, 'viewer', 'doc')),
            anyone: await collect(s.reverse(user('*'), 'viewer', 'doc')),
          };
          return { out, reads: s.reads };
        };
        const atT = { d1: ['group:g1#member', 'user:alice'], numeric: ['user:bob'], uuid: ['user:*'], g1: ['user:alice'], alice: ['doc:d1'], set: ['doc:d1'], anyone: [`doc:${uuid}`] };
        expect((await reads()).out).to.deep.equal(atT);

        await store.write([viewer('d1', user('frank'))], [viewer('d1', user('alice')), viewer('d1', G1_MEMBERS), viewer(uuid, user('*'))], ADMIN);
        await store.write([], [viewer(numeric, user('bob'))], ADMIN);
        await store.write([viewer(numeric, user('bob'))], [], ADMIN);
        await pause(WINDOW);

        const replayed = await reads();
        expect(replayed.out).to.deep.equal(atT);
        expect(replayed.reads.filter((r) => r.origin === 'gap')).to.deep.equal([]);
        const hash = (t: Tuple) => createHash('sha256').update(tupleKey(t)).digest('hex');
        expect(replayed.reads.filter((r) => r.origin === 'history').map((r) => r.key)).to.include.members([hash(viewer('d1', user('alice'))), hash(viewer(numeric, user('bob')))]);
      });

      it("a conditional tuple's caveat context comes back exactly as it was at T", async () => {
        const conditional = { ...viewer('c1', user('u1')), caveat: { name: 'draft', context: { 'resource.status': 'draft', 'env.levels': [1, 2] } } };
        const key = createHash('sha256').update(tupleKey(conditional)).digest('hex');
        await db.driver.transaction(() => changeLog().append([{ kind: 'tuple', op: 'add', key, payload: conditional }]));
        await pause(3 * WINDOW);
        const T = new Date();
        await pause(3 * WINDOW);
        await db.driver.transaction(() => changeLog().append([{ kind: 'tuple', op: 'remove', key, payload: conditional }]));
        const subjects: TupleSubjectRef[] = [];
        for await (const s of (await sourceAt(T)).read({ type: 'doc', id: 'c1' }, 'viewer')) subjects.push(s);
        expect(subjects).to.deep.equal([{ type: 'user', id: 'u1', caveat: conditional.caveat }]);
      });
    });
  }
});
