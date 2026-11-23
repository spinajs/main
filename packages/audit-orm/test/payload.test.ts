import * as chai from 'chai';
import 'mocha';
import { createHash } from 'node:crypto';
import { audit, canonicalJson } from '@spinajs/audit';
import type { AuditWriteMode, AuditWriteOptions } from '@spinajs/audit';
import '../src/index.js';
import { DIALECTS, TestDb } from './support/db.js';

const expect = chai.expect;

const tableOf = (dialect: string): string => `audit_p_${dialect}`;
const trailOf = (dialect: string): string => `p_${dialect}`;
const TRAILS = Object.fromEntries(DIALECTS.map((d) => [trailOf(d), { connection: d, table: tableOf(d), onFailure: 'continue', retry: { attempts: 1, delay: 1 } }]));
const AT = new Date('2026-11-23T10:15:30.123Z');

interface Shape {
  readonly action: string;
  readonly data?: Record<string, unknown>;
  readonly options?: Pick<AuditWriteOptions, 'mask' | 'omit'>;
  // What the stored payload holds: the input after omit and mask.
  readonly stored: Record<string, unknown>;
}

const SHAPES: readonly Shape[] = [
  { action: 'nested', data: { z: { y: { x: 1, b: [3, { d: 1, c: 2 }] } }, a: null }, stored: { a: null, z: { y: { b: [3, { c: 2, d: 1 }], x: 1 } } } },
  { action: 'unsorted', data: { zeta: 'z', Alpha: 'A', 10: 'ten', 2: 'two', é: 'e' }, stored: { 10: 'ten', 2: 'two', Alpha: 'A', zeta: 'z', é: 'e' } },
  { action: 'dates', data: { when: AT, list: [AT], deep: { at: AT } }, stored: { deep: { at: AT.toISOString() }, list: [AT.toISOString()], when: AT.toISOString() } },
  { action: 'masked', data: { card: { number: '4111', holder: 'Ann' }, total: 10 }, options: { mask: ['data.card.number'] }, stored: { card: { holder: 'Ann', number: '***' }, total: 10 } },
  { action: 'omitted', data: { secret: 's3', keep: true, nested: { token: 't', id: 1 } }, options: { omit: ['data.secret', 'data.nested.token'] }, stored: { keep: true, nested: { id: 1 } } },
  { action: 'empty', stored: {} },
  { action: 'empty.object', data: {}, stored: {} },
];

const MODES: readonly AuditWriteMode[] = ['deferred', 'confirmed', 'transactional'];

function columnsOf(stored: Record<string, unknown>): { data: string; data_hash: string } {
  const data = canonicalJson(stored);
  return { data, data_hash: createHash('sha256').update(data, 'utf8').digest('hex') };
}

describe('the stored payload of a recorded event', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open({ trails: TRAILS });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      const trail = trailOf(dialect);

      before(function () {
        if (!db.has(dialect)) this.skip();
      });

      beforeEach(async () => {
        await db.migrate(dialect, tableOf(dialect));
      });

      afterEach(async () => {
        await db.drop(dialect, tableOf(dialect));
      });

      for (const mode of MODES) {
        it(`is the canonical JSON of the masked input and its SHA-256 for a ${mode} write`, async () => {
          const driver = db.driver(dialect);
          for (const shape of SHAPES) {
            const input = { kind: 'custom', action: shape.action, data: shape.data } as const;
            const options: AuditWriteOptions = { ...shape.options, trail, mode };
            if (mode === 'transactional') await driver.transaction(() => audit().record(input, { ...options, transaction: driver }));
            else await audit().record(input, options);
          }
          await audit().flush();

          const rows = await db.rows(dialect, tableOf(dialect));
          expect(rows.map((r) => ({ action: r.action, data: r.data, data_hash: r.data_hash }))).to.deep.eq(SHAPES.map((s) => ({ action: s.action, ...columnsOf(s.stored) })));
        });
      }

      it('is what the payload holds when a deferred write is flushed', async () => {
        const data = { n: 1, list: ['a'] };
        await audit().record({ kind: 'custom', action: 'changed', data }, { trail, mode: 'deferred' });
        data.n = 2;
        data.list.push('b');
        await audit().flush();
        const [row] = await db.rows(dialect, tableOf(dialect));
        expect({ data: row.data, data_hash: row.data_hash }).to.deep.eq(columnsOf({ list: ['a', 'b'], n: 2 }));
      });
    });
  }
});
