import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { hostname } from 'os';
import { defaultReplicaId, SqlDbTimeSource } from '../src/index.js';
import { bootTestEnv } from './support/env.js';

describe('database time', () => {
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
