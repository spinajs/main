/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
// Registers the concrete logger, as every suite in this package does.
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { mergeInsertResults, Orm, OrmException, RawQuery } from '@spinajs/orm';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

function connection(): FakeSqliteDriver {
  return DI.get(Orm)!.Connections.get('sqlite') as FakeSqliteDriver;
}

const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ a: `a${i}`, b: `b${i}`, c: `c${i}` }));

function limitTo(features: { maxBindParameters?: number; maxInsertRows?: number }) {
  const driver = connection();
  const base = driver.supportedFeatures();
  sinon.stub(driver, 'supportedFeatures').returns({ ...base, ...features } as any);

  const executed: { stmt: string; params: unknown[] }[] = [];
  sinon.stub(driver, 'executeOnDb').callsFake(async (stmt: any, params: any) => {
    executed.push({ stmt, params });
    return { RowsAffected: params.length / 3, LastInsertId: executed.length, Returning: [] };
  });

  return { driver, executed, transaction: sinon.spy(driver, 'transaction') };
}

describe('insert split by driver limits', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('splits 7 rows of 3 columns into statements of at most 10 bindings, in order, in one transaction', async () => {
    const { driver, executed, transaction } = limitTo({ maxBindParameters: 10 });

    const result = await driver.insert().into('t').values(rows(7));

    expect(executed.map((e) => e.stmt)).to.deep.eq([
      'INSERT INTO `t` (`a`,`b`,`c`) VALUES (?,?,?),(?,?,?),(?,?,?)',
      'INSERT INTO `t` (`a`,`b`,`c`) VALUES (?,?,?),(?,?,?),(?,?,?)',
      'INSERT INTO `t` (`a`,`b`,`c`) VALUES (?,?,?)',
    ]);
    expect(executed.flatMap((e) => e.params)).to.deep.eq(rows(7).flatMap((r) => [r.a, r.b, r.c]));
    expect(transaction.calledOnce).to.eq(true);
    expect(result).to.deep.eq({ RowsAffected: 7, LastInsertId: 3, Returning: [] });
  });

  it('keeps a payload that fits as one statement and opens no transaction', async () => {
    const { driver, executed, transaction } = limitTo({ maxBindParameters: 9 });

    await driver.insert().into('t').values(rows(3));

    expect(executed).to.have.length(1);
    expect(transaction.called).to.eq(false);
  });

  it('never splits when the driver declares no limit', async () => {
    const { driver, executed } = limitTo({});

    await driver.insert().into('t').values(rows(5000));

    expect(executed).to.have.length(1);
  });

  it("joins the caller's transaction instead of opening one", async () => {
    const { driver, executed, transaction } = limitTo({ maxBindParameters: 10 });

    await driver.transaction(async () => {
      await driver.insert().into('t').values(rows(7));
    });

    expect(executed).to.have.length(3);
    expect(transaction.calledOnce).to.eq(true);
  });

  it('caps the rows per statement at maxInsertRows', async () => {
    const { driver, executed } = limitTo({ maxInsertRows: 2 });

    await driver.insert().into('t').values(rows(5));

    expect(executed.map((e) => e.params.length)).to.deep.eq([6, 6, 3]);
  });

  it("reserves the bindings of an upsert's raw update columns", () => {
    limitTo({ maxBindParameters: 9 });
    const plain = connection().insert().into('t').values(rows(3));
    const upsert = connection().insert().into('t').values(rows(3));
    upsert.onDuplicate('a').update([RawQuery.create('`b` = `b` + ?', [1])]);

    expect(plain.splitByDriverLimits()).to.deep.eq([plain]);
    expect(upsert.splitByDriverLimits().map((c) => c.Values.length)).to.deep.eq([2, 1]);
    expect(upsert.Values).to.have.length(3);
  });

  it('refuses a row wider than the limit', () => {
    limitTo({ maxBindParameters: 2 });

    expect(() => connection().insert().into('t').values(rows(1)).splitByDriverLimits()).to.throw(OrmException, 'bound parameters');
  });

  it('merges RETURNING rows in insert order and arrays of rows by concatenation', () => {
    expect(
      mergeInsertResults([
        { RowsAffected: 2, LastInsertId: 0, Returning: [{ Id: 1 }, { Id: 2 }] },
        { RowsAffected: 1, LastInsertId: 0, Returning: [{ Id: 3 }] },
      ]),
    ).to.deep.eq({ RowsAffected: 3, LastInsertId: 0, Returning: [{ Id: 1 }, { Id: 2 }, { Id: 3 }] });

    expect(mergeInsertResults([[{ Id: 1 }], [{ Id: 2 }]])).to.deep.eq([{ Id: 1 }, { Id: 2 }]);
  });
});
