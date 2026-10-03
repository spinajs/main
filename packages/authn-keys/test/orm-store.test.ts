import 'mocha';
import assert from 'node:assert/strict';
import type { KeyRecord } from '@spinajs/authn/contracts';
import { generateKeyPair } from '@spinajs/authn-testing';
import { thumbprint } from '../src/jwk/index.js';
import { OrmKeyStore } from '../src/registry/index.js';
import { bootSqlite, clearKeys } from './db.js';

function withZone<T>(zone: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.TZ;
  process.env.TZ = zone;
  return fn().finally(() => {
    if (before === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = before;
    }
  });
}

describe('OrmKeyStore', () => {
  beforeEach(async () => {
    await bootSqlite();
    await clearKeys();
  });

  it('round-trips a key and keeps its instants whatever the process time zone', async () => {
    const store = new OrmKeyStore();
    const kp = generateKeyPair('ES256');
    const at = new Date(Date.UTC(2026, 9, 25, 0, 30, 0));
    const key = { alg: 'ES256', jwk: kp.publicJwk, kid: 'k-1', owner: { type: 'service', id: 's' }, thumbprint: thumbprint(kp.publicJwk), name: 'n', scope: { roles: ['r'] }, createdAt: at, createdBy: { type: 'user', id: 'admin' }, expiresAt: new Date(at.getTime() + 3_600_000) } as KeyRecord;
    await withZone('America/New_York', () => store.insert(key));
    const read = await withZone('Asia/Tokyo', () => store.get('k-1'));
    assert.deepStrictEqual(read, key);
    assert.strictEqual(await withZone('Europe/Warsaw', () => store.revoke({ type: 'service', id: 's' }, 'k-1', at)), 'revoked');
    assert.strictEqual((await withZone('Asia/Tokyo', () => store.get('k-1')))?.revokedAt?.getTime(), at.getTime());
    assert.strictEqual(await store.revoke({ type: 'service', id: 's' }, 'k-1', new Date()), 'already');
    assert.strictEqual(await store.revoke({ type: 'agent', id: 's' }, 'k-1', new Date()), 'none');
  });

  it('reports a duplicate kid or thumbprint', async () => {
    const store = new OrmKeyStore();
    const kp = generateKeyPair('EdDSA');
    const key = { alg: 'EdDSA', jwk: kp.publicJwk, kid: 'k-2', owner: { type: 'service', id: 's' }, thumbprint: thumbprint(kp.publicJwk), createdAt: new Date() } as KeyRecord;
    assert.strictEqual(await store.insert(key), 'inserted');
    assert.strictEqual(await store.insert({ ...key, kid: 'k-3' }), 'duplicate');
    const other = generateKeyPair('EdDSA');
    assert.strictEqual(await store.insert({ ...key, jwk: other.publicJwk, thumbprint: thumbprint(other.publicJwk) } as KeyRecord), 'duplicate');
  });
});
