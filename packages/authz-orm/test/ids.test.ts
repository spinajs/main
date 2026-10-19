import * as chai from 'chai';
import 'mocha';

import { idLookup, idText } from '../src/ids.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';

const expect = chai.expect;

const REF = '0b6c6f1e-5f43-4a3e-9d3e-2a4b1c0d9e8f';

describe('authz-orm ids', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  it('idText reads string, safe number and bigint keys as text, and nothing else', () => {
    expect(idText('a1')).to.equal('a1');
    expect(idText(7)).to.equal('7');
    expect(idText(9007199254740993n)).to.equal('9007199254740993');
    expect(idText(2 ** 53)).to.equal(undefined);
    expect(idText(1.5)).to.equal(undefined);
    expect(idText(null)).to.equal(undefined);
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      afterEach(async () => {
        await db.clear();
      });

      it('binds a text id only where the key column can hold it', async () => {
        const Keyed = await db.define({ name: 'Keyed', columns: { id: 'INTEGER', ref: dialect === 'postgres' ? 'UUID' : 'TEXT', code: 'TEXT', big: 'BIGINT', amount: 'NUMERIC' } }, dialect);
        expect(idLookup(Keyed, 'id', '42')).to.equal(42);
        expect(idLookup(Keyed, 'id', 'abc')).to.equal(undefined);
        expect(idLookup(Keyed, 'id', '4.2')).to.equal(undefined);
        expect(idLookup(Keyed, 'big', '9007199254740993')).to.equal('9007199254740993');
        expect(idLookup(Keyed, 'amount', '4.2')).to.equal('4.2');
        expect(idLookup(Keyed, 'code', 'abc')).to.equal('abc');
        expect(idLookup(Keyed, 'missing', 'abc')).to.equal('abc');
        if (dialect === 'postgres') {
          expect(idLookup(Keyed, 'ref', 'abc')).to.equal(undefined);
          expect(idLookup(Keyed, 'ref', REF)).to.equal(REF);
        }
      });
    });
  }
});
