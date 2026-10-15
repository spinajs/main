import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { RawQuery } from '@spinajs/orm';

import './migrations/PgTypesMigration_2026_10_15_00_02_00.js';
import { IPgSuite, openSuite, sqlState } from './harness.js';
import { PgTyped } from './models/types.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

describe('postgres integration - column types', function () {
  let suite: IPgSuite;

  before(async function () {
    suite = await openSuite(this, { name: 'types' });
  });

  beforeEach(async () => {
    await suite.reset('pg_typed');
  });

  after(async () => {
    await suite?.close();
  });

  it('round-trips a JSON document through JSONB', async () => {
    const doc = { a: 1, list: [1, 'two', null], nested: { ok: true } };
    await new PgTyped({ Data: doc }).insert();

    expect((await PgTyped.get(1)).Data).to.deep.equal(doc);
  });

  it('queries inside JSONB with ->>', async () => {
    await new PgTyped({ Data: { a: 1 } }).insert();
    await new PgTyped({ Data: { a: 2 } }).insert();

    expect((await PgTyped.where(RawQuery.create(`"Data"->>'a' = ?`, ['2']))).map((r) => r.Id)).to.deep.equal([2]);
  });

  it('round-trips a JSON string value', async () => {
    await new PgTyped({ Data: 'plain' }).insert();

    expect((await PgTyped.get(1)).Data).to.equal('plain');
  });

  it('updates a JSON column through the model', async () => {
    const m = await PgTyped.create({ Data: { v: 1 } });
    m.Data = { v: 2 };
    await m.update();

    expect((await PgTyped.get(m.Id)).Data).to.deep.equal({ v: 2 });
  });

  it('round-trips booleans and filters by them', async () => {
    await new PgTyped({ Flag: true }).insert();
    await new PgTyped({ Flag: false }).insert();

    expect((await PgTyped.all()).map((r) => r.Flag)).to.deep.equal([true, false]);
    expect((await PgTyped.where('Flag', true)).map((r) => r.Id)).to.deep.equal([1]);
  });

  it('returns NUMERIC and BIGINT as exact strings', async () => {
    await new PgTyped({ Price: '12.5' as string, Big: '9007199254740993' }).insert();
    const row = await PgTyped.get(1);

    expect(row.Price).to.equal('12.50');
    expect(row.Big).to.equal('9007199254740993');
  });

  it('returns DOUBLE PRECISION as a number', async () => {
    await new PgTyped({ Ratio: 0.25 }).insert();

    expect((await PgTyped.get(1)).Ratio).to.equal(0.25);
  });

  it('enforces enum members with a CHECK constraint', async () => {
    await new PgTyped({ Kind: 'live' }).insert();
    const err = await new PgTyped({ Kind: 'gone' }).insert().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(sqlState(err)).to.equal('23514');
  });

  it('round-trips binary data through BYTEA', async () => {
    const payload = Buffer.from('00ff10ab', 'hex');
    await new PgTyped({ Payload: payload }).insert();

    expect(Buffer.compare((await PgTyped.get(1)).Payload, payload)).to.equal(0);
  });
});
