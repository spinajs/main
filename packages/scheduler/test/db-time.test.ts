import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { hostname } from 'os';
import { dbNowSql, defaultReplicaId, SqlDbTimeSource } from '../src/index.js';
import { bootTestEnv } from './support/env.js';

describe('database time', () => {
  it('has a query per supported driver', () => {
    expect(dbNowSql('orm-driver-sqlite')).to.contain('julianday');
    expect(dbNowSql('orm-driver-mysql')).to.contain('UNIX_TIMESTAMP(NOW(3))');
    expect(dbNowSql('orm-driver-mysql-ssh')).to.contain('UNIX_TIMESTAMP');
    expect(dbNowSql('orm-driver-postgres')).to.contain('clock_timestamp()');
    expect(() => dbNowSql('orm-driver-mssql')).to.throw(/no database time query/);
  });

  it('reads sqlite time in epoch milliseconds', async () => {
    await bootTestEnv();
    const ms = await DI.resolve(SqlDbTimeSource).read();
    expect(Math.abs(ms - Date.now())).to.be.lessThan(5000);
  });
});

describe('replica id', () => {
  it('is host:pid:random and stable per process', () => {
    const id = defaultReplicaId();
    const host = hostname().replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
    expect(id).to.match(new RegExp(`^${host}:${process.pid}:[0-9a-f]{6}$`));
    expect(defaultReplicaId()).to.eq(id);
  });
});
