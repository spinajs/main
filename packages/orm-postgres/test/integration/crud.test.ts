/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import './migrations/PgCoreMigration_2026_10_15_00_00_00.js';
import { IPgSuite, openSuite } from './harness.js';
import { PgAutoKey, PgBytesUuid, PgCompositeKey, PgNativeUuid, PgUuidKey } from './models/core.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

type Affected = { RowsAffected: number };

describe('postgres integration - crud and keys', function () {
  let suite: IPgSuite;

  before(async function () {
    suite = await openSuite(this, { name: 'crud' });
  });

  beforeEach(async () => {
    await suite.reset('pg_auto_key', 'pg_uuid_key', 'pg_composite_key', 'pg_bytes_uuid', 'pg_native_uuid');
  });

  after(async () => {
    await suite?.close();
  });

  it('learns an identity key from RETURNING on insert', async () => {
    const m = new PgAutoKey({ Name: 'a' });
    await m.insert();

    expect(m.Id).to.equal(1);
    expect((await PgAutoKey.get(1)).Name).to.equal('a');
  });

  it('gives every row of a batch its own key, in order', async () => {
    const rows = [new PgAutoKey({ Name: 'b1' }), new PgAutoKey({ Name: 'b2' }), new PgAutoKey({ Name: 'b3' })];
    await PgAutoKey.insert(rows);

    expect(rows.map((r) => r.Id)).to.deep.equal([1, 2, 3]);
    expect((await PgAutoKey.get(3)).Name).to.equal('b3');
  });

  it('supports RETURNING on a plain insert builder', async () => {
    const result = (await suite.driver.insert().into('pg_auto_key').values({ Name: 'r' }).returning(['Id', 'Name'])) as any;
    expect(result.Returning).to.deep.equal([{ Id: 1, Name: 'r' }]);
  });

  it('counts rows as a number', async () => {
    await PgAutoKey.insert([{ Name: 'a' }, { Name: 'b' }] as any);
    expect(await PgAutoKey.count()).to.equal(2);
  });

  it('needs setval after explicit identity keys (documented limitation)', async () => {
    await PgAutoKey.insert([{ Id: 2, Name: 'explicit' }, { Name: 'auto' }] as any);
    await suite.raw(`SELECT setval(pg_get_serial_sequence('"pg_auto_key"', 'Id'), (SELECT max("Id") FROM "pg_auto_key"))`);
    await PgAutoKey.insert([{ Name: 'auto2' }, { Name: 'auto3' }] as any);

    expect((await PgAutoKey.all()).map((r) => r.Name).sort()).to.deep.equal(['auto', 'auto2', 'auto3', 'explicit']);
  });

  it('reports affected rows for update and delete', async () => {
    await PgAutoKey.insert([{ Name: 'a' }, { Name: 'a' }, { Name: 'b' }] as any);

    const updated = (await suite.driver.update().in('pg_auto_key').update({ Name: 'z' }).where('Name', 'a')) as unknown as Affected;
    const none = (await suite.driver.update().in('pg_auto_key').update({ Name: 'q' }).where('Name', 'missing')) as unknown as Affected;
    const deleted = (await suite.driver.del().from('pg_auto_key').where('Name', 'z')) as unknown as Affected;

    expect([updated.RowsAffected, none.RowsAffected, deleted.RowsAffected]).to.deep.equal([2, 0, 2]);
  });

  it('updates and destroys a model instance', async () => {
    const m = await PgAutoKey.create({ Name: 'before' });
    m.Name = 'after';
    await m.update();
    expect((await PgAutoKey.get(m.Id)).Name).to.equal('after');

    await m.destroy();
    expect(await PgAutoKey.get(m.Id)).to.be.undefined;
  });

  it('keeps a client generated uuid key', async () => {
    const m = new PgUuidKey({ Name: 'u' });
    await m.insert();

    expect(m.Id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect((await PgUuidKey.get(m.Id)).Name).to.equal('u');
  });

  it('learns a database generated native uuid key from RETURNING', async () => {
    const m = new PgNativeUuid({ Name: 'n' });
    await m.insert();

    expect(m.Id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect((await PgNativeUuid.get(m.Id)).Name).to.equal('n');
  });

  it('round-trips a uuid stored as BYTEA through @Uuid', async () => {
    const ref = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    await new PgBytesUuid({ Ref: ref }).insert();

    expect((await PgBytesUuid.get(1)).Ref).to.equal(ref);
  });

  it('addresses exactly one row by a composite key', async () => {
    await new PgCompositeKey({ TenantId: 1, Code: 'a', Name: 'A' }).insert();
    await new PgCompositeKey({ TenantId: 1, Code: 'b', Name: 'B' }).insert();

    const m = await PgCompositeKey.get([1, 'a']);
    m.Name = 'A2';
    await m.update();
    await PgCompositeKey.destroy([[1, 'b']]);

    expect((await PgCompositeKey.all()).map((r) => [r.TenantId, r.Code, r.Name])).to.deep.equal([[1, 'a', 'A2']]);
  });

  it('finds exactly the named composite tuples', async () => {
    await PgCompositeKey.insert([
      { TenantId: 1, Code: 'a', Name: 'A' },
      { TenantId: 2, Code: 'a', Name: 'C' },
      { TenantId: 1, Code: 'b', Name: 'B' },
    ] as any);

    const rows = await PgCompositeKey.find([
      [1, 'a'],
      [2, 'a'],
    ]);
    expect(rows.map((r) => r.Name).sort()).to.deep.equal(['A', 'C']);
  });
});
