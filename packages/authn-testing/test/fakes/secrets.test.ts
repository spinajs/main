import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'mocha';
import { FakeClock, MemorySecretStore } from '../../src/fakes/index.js';

const A = { type: 'user', id: 'a' };
const B = { type: 'user', id: 'b' };

describe('MemorySecretStore', () => {
  let clock: FakeClock;
  let store: MemorySecretStore;
  beforeEach(() => {
    clock = new FakeClock(new Date('2030-01-01T00:00:00Z'));
    clock.install();
    store = new MemorySecretStore();
  });
  afterEach(() => clock.uninstall());

  it('issues at least 128 random bits and keeps only the SHA-256', async () => {
    const raw = await store.issue(A, 'reset', 60);
    assert.ok(Buffer.from(raw, 'base64url').length >= 16);
    assert.notEqual(raw, await store.issue(A, 'invite', 60));
    const [row] = store.rows().filter((r) => r.purpose === 'reset');
    assert.equal(row.hash, createHash('sha256').update(raw).digest('hex'));
    assert.equal(JSON.stringify(store.rows()).includes(raw), false);
    assert.equal(row.expiresAt.getTime(), clock.now().getTime() + 60_000);
    assert.equal(row.usedAt, null);
  });

  it('redeems once', async () => {
    const raw = await store.issue(A, 'reset', 60);
    assert.equal(await store.redeem(A, 'reset', raw), true);
    assert.equal(await store.redeem(A, 'reset', raw), false);
    assert.notEqual(store.rows()[0].usedAt, null);
  });

  it('binds a secret to its purpose and identity', async () => {
    const raw = await store.issue(A, 'reset', 60);
    assert.equal(await store.redeem(A, 'invite', raw), false);
    assert.equal(await store.redeem(B, 'reset', raw), false);
    assert.equal(await store.redeem(A, 'reset', raw), true);
  });

  it('keeps only the latest secret per identity and purpose', async () => {
    const first = await store.issue(A, 'reset', 60);
    const second = await store.issue(A, 'reset', 60);
    const other = await store.issue(B, 'reset', 60);
    assert.equal(store.rows().filter((r) => r.identity.id === 'a').length, 1);
    assert.equal(await store.redeem(A, 'reset', first), false);
    assert.equal(await store.redeem(A, 'reset', second), true);
    assert.equal(await store.redeem(B, 'reset', other), true);
  });

  it('rejects wrong secrets', async () => {
    await store.issue(A, 'reset', 60);
    assert.equal(await store.redeem(A, 'reset', 'nope'), false);
    assert.equal(await store.redeem(A, 'reset', ''), false);
  });

  it('expires through Date', async () => {
    const raw = await store.issue(A, 'reset', 60);
    clock.tick(59_999);
    assert.equal(await store.redeem(A, 'reset', raw), true);
    const raw2 = await store.issue(A, 'reset', 60);
    clock.tick(60_000);
    assert.equal(await store.redeem(A, 'reset', raw2), false);
  });

  it('seedHash plants a row that a matching raw secret redeems', async () => {
    const hash = createHash('sha256').update('planted').digest('hex');
    store.seedHash(A, 'invite', hash, new Date(Date.now() + 1000), new Date());
    assert.equal(store.rows().length, 1);
    assert.equal(await store.redeem(A, 'invite', 'planted'), true);
  });
});
