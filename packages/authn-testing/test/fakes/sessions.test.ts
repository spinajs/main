import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import 'mocha';
import type { AuthnFacts } from '@spinajs/authn/contracts';
import { FakeClock, MemorySessionIssuer } from '../../src/fakes/index.js';

const A = { type: 'user', id: 'a' };
const B = { type: 'user', id: 'b' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const facts = (over: Partial<AuthnFacts> = {}): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), ...over });

describe('MemorySessionIssuer', () => {
  let clock: FakeClock;
  let s: MemorySessionIssuer;
  beforeEach(() => {
    clock = new FakeClock(new Date('2030-01-01T00:00:00Z'));
    clock.install();
    s = new MemorySessionIssuer();
  });
  afterEach(() => clock.uninstall());

  it('issues ids of at least 128 bits and stores only their hash', async () => {
    const h = await s.issue(A, facts());
    assert.equal(h.state, 'active');
    assert.ok(Buffer.from(h.id, 'base64url').length >= 16);
    assert.deepEqual(await s.storage.storedKeys(), [sha(h.id)]);
    assert.notEqual((await s.issue(A, facts())).id, h.id);
  });

  it('restores by raw id and refuses the stored hash as an id', async () => {
    const h = await s.issue(A, facts());
    const r = await s.restore(h.id);
    assert.deepEqual(r?.identity, A);
    assert.equal(r?.handle.id, h.id);
    assert.equal(await s.restore(sha(h.id)), null);
    assert.equal(await s.restore('unknown'), null);
  });

  it('puts the one-way handle in facts and the list', async () => {
    const h = await s.issue(A, facts());
    const r = (await s.restore(h.id))!;
    const [row] = await s.list(A);
    assert.equal(r.facts.sessionHandle, row.handle);
    assert.equal(row.handle, sha('authn-testing/handle\0' + sha(h.id)));
    assert.notEqual(row.handle, h.id);
    assert.notEqual(row.handle, sha(h.id));
  });

  it('migrates a 2.x raw uuid v4 on first use as aal1', async () => {
    const rawId = randomUUID();
    const creation = new Date(Date.now() - 60_000);
    await s.storage.seedLegacy({ rawId, user: 'legacy-u', authorized: true, creation });
    assert.deepEqual(await s.storage.storedKeys(), [rawId]);
    const r = (await s.restore(rawId))!;
    assert.deepEqual(r.identity, { type: 'user', id: 'legacy-u' });
    assert.equal(r.facts.assurance, 'aal1');
    assert.deepEqual(r.facts.mfa, []);
    assert.equal(r.facts.authenticatedAt.getTime(), creation.getTime());
    assert.deepEqual(await s.storage.storedKeys(), [sha(rawId)]);
    assert.ok(await s.restore(rawId));
  });

  it('keeps a legacy impersonator and does not migrate non-uuid ids', async () => {
    const rawId = randomUUID();
    await s.storage.seedLegacy({ rawId, user: 'target', authorized: true, creation: new Date(), impersonator: 'admin' });
    const r = (await s.restore(rawId))!;
    assert.deepEqual(await s.revokeAll({ type: 'user', id: 'admin' }, { includeImpersonations: true }), 1);
    assert.equal(r.identity.id, 'target');
    await s.storage.seedLegacy({ rawId: 'not-a-uuid', user: 'x', authorized: true, creation: new Date() });
    assert.equal(await s.restore('not-a-uuid'), null);
  });

  it('expires after the idle time and slides on restore, capped by the absolute time', async () => {
    const h = await s.issue(A, facts());
    clock.tick(29 * 60_000);
    assert.ok(await s.restore(h.id));
    clock.tick(29 * 60_000);
    assert.ok(await s.restore(h.id));
    clock.tick(31 * 60_000);
    assert.equal(await s.restore(h.id), null);

    const capped = new MemorySessionIssuer({ idleMinutes: 30, absoluteMinutes: 40 });
    const c = await capped.issue(A, facts());
    clock.tick(25 * 60_000);
    assert.ok(await capped.restore(c.id));
    clock.tick(16 * 60_000);
    assert.equal(await capped.restore(c.id), null);
  });

  it('a pending session expires at the pending ttl and never slides', async () => {
    const h = await s.issue(A, facts(), { pending: { steps: ['fake'] } });
    assert.equal(h.state, 'pending');
    clock.tick(299_000);
    assert.equal((await s.restore(h.id))?.handle.state, 'pending');
    clock.tick(2000);
    assert.equal(await s.restore(h.id), null);
  });

  it('rotate gives a new id, keeps the data and kills the old id', async () => {
    const h = await s.issue(A, facts());
    await s.set(h, 'ActiveRole', 'editor');
    const before = (await s.restore(h.id))!.facts.sessionHandle;
    const n = await s.rotate(h);
    assert.notEqual(n.id, h.id);
    assert.equal(await s.restore(h.id), null);
    const r = (await s.restore(n.id))!;
    assert.equal(r.data.get('ActiveRole'), 'editor');
    assert.notEqual(r.facts.sessionHandle, before);
    assert.deepEqual(await s.storage.storedKeys(), [sha(n.id)]);
    await assert.rejects(s.rotate(h));
  });

  it('elevate turns pending into active aal2, merges facts and rotates', async () => {
    const h = await s.issue(A, facts(), { pending: { steps: ['fake'] } });
    const n = await s.elevate(h, { mfa: ['fake'] });
    assert.equal(n.state, 'active');
    assert.equal(await s.restore(h.id), null);
    const r = (await s.restore(n.id))!;
    assert.equal(r.facts.assurance, 'aal2');
    assert.deepEqual(r.facts.mfa, ['fake']);
    clock.tick(10 * 60_000);
    assert.ok(await s.restore(n.id));
  });

  it('elevate refuses an active session', async () => {
    const h = await s.issue(A, facts());
    await assert.rejects(s.elevate(h, {}));
    assert.ok(await s.restore(h.id));
  });

  it('set refuses the reserved keys', async () => {
    const h = await s.issue(A, facts());
    for (const key of ['Subject', 'Impersonator', 'State', 'authn:facts']) {
      await assert.rejects(s.set(h, key, 'x'), key);
    }
    await s.set(h, 'ok', 1);
    assert.equal((await s.restore(h.id))!.data.get('ok'), 1);
  });

  it('issue stores facts.impersonator as the row impersonator', async () => {
    const h = await s.issue(B, facts({ impersonator: A }));
    assert.deepEqual((await s.restore(h.id))!.facts.impersonator, A);
  });

  it('revoke ends one session', async () => {
    const h = await s.issue(A, facts());
    await s.revoke(h);
    assert.equal(await s.restore(h.id), null);
    await s.revoke(h);
  });

  it('revokeAll counts, honours except, and includes impersonations only on request', async () => {
    const a1 = await s.issue(A, facts());
    const a2 = await s.issue(A, facts());
    const b1 = await s.issue(B, facts());
    const imp = await s.issue(B, facts({ impersonator: A }));
    assert.equal(await s.revokeAll(A, { except: a1 }), 1);
    assert.equal(await s.restore(a2.id), null);
    assert.ok(await s.restore(a1.id));
    assert.ok(await s.restore(imp.id));
    assert.equal(await s.revokeAll(A, { includeImpersonations: true }), 2);
    assert.equal(await s.restore(imp.id), null);
    assert.equal(await s.restore(a1.id), null);
    assert.ok(await s.restore(b1.id));
    assert.equal(await s.revokeAll(A), 0);
  });

  it('revokeAll also ends pending sessions of the subject', async () => {
    const p = await s.issue(A, facts(), { pending: { steps: ['fake'] } });
    assert.equal(await s.revokeAll(A), 1);
    assert.equal(await s.restore(p.id), null);
  });

  it('list gives one-way handles, marks current and includes impersonations of the subject only', async () => {
    const a1 = await s.issue(A, facts());
    await s.issue(A, facts());
    await s.issue(B, facts({ impersonator: A }));
    const rows = await s.list(A, { current: a1 });
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.current).length, 1);
    assert.equal((await s.restore(a1.id))!.facts.sessionHandle, rows.find((r) => r.current)!.handle);
    assert.equal((await s.list(B)).length, 1);
    assert.deepEqual(
      rows.map((r) => r.createdAt.getTime()),
      [clock.now().getTime(), clock.now().getTime()],
    );
  });

  it('revokeHandle is owner-bound and takes the listed handle only', async () => {
    const a1 = await s.issue(A, facts());
    const imp = await s.issue(B, facts({ impersonator: A }));
    const [aRow] = await s.list(A);
    const [bRow] = await s.list(B);
    assert.equal(await s.revokeHandle(B, aRow.handle), false);
    assert.ok(await s.restore(a1.id));
    assert.equal(await s.revokeHandle(A, bRow.handle), false);
    assert.ok(await s.restore(imp.id));
    assert.equal(await s.revokeHandle(A, a1.id), false);
    assert.equal(await s.revokeHandle(A, sha(a1.id)), false);
    assert.equal(await s.revokeHandle(A, aRow.handle), true);
    assert.equal(await s.restore(a1.id), null);
    assert.equal(await s.revokeHandle(A, aRow.handle), false);
    assert.equal(await s.revokeHandle(B, bRow.handle), true);
  });
});
