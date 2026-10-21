import 'mocha';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthnAudit } from '@spinajs/authn/audit';
import { InProcessCredentialChangeBus } from '@spinajs/authn/bus';
import type { AuthnContext, IdentityRef, IdentityStatus, TokenCreateOptions } from '@spinajs/authn/contracts';
import { FakeClock, FakeIdentityStore } from '@spinajs/authn-testing';

import '../src/generator.js';
import { DbTokenService, NoTokenProfilesPolicy } from '../src/service/index.js';
import type { TokenCacheConfig } from '../src/service/index.js';
import { bootV3Db, insertUserRow, shutdownV3Db, v3Connection } from './v3/db.js';
import { tokenServiceOver } from './v3/services.js';

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const CACHE_PATH = ['authn', 'token', 'cache'];

type Executor = { executeOnDb(stmt: unknown, params: unknown[], context: unknown): Promise<unknown> };

/** Every statement the sqlite connection runs until `restore()`. */
function recordStatements(): { readonly statements: string[]; reset(): void; restore(): void } {
  const driver = v3Connection() as unknown as Executor;
  const run = driver.executeOnDb.bind(driver);
  const statements: string[] = [];
  driver.executeOnDb = (stmt: unknown, params: unknown[], context: unknown) => {
    statements.push(String(stmt));
    return run(stmt, params, context);
  };
  return {
    statements,
    reset: () => void statements.splice(0),
    restore: () => {
      // The own property shadows the driver's method; removing it brings the method back.
      delete (driver as Partial<Executor>).executeOnDb;
    },
  };
}

/** A FakeIdentityStore that counts status reads and can hold them until released. */
class CountingIdentityStore extends FakeIdentityStore {
  public statusCalls = 0;
  public gate: Promise<void> | null = null;

  public async status(id: IdentityRef): Promise<IdentityStatus> {
    this.statusCalls++;
    if (this.gate) {
      await this.gate;
    }
    return super.status(id);
  }
}

describe('DbTokenService validation cache', function () {
  this.timeout(30000);

  let clock: FakeClock;
  let recorder: ReturnType<typeof recordStatements>;
  let savedCache: unknown;

  before(async () => {
    await bootV3Db();
  });

  after(async () => {
    await shutdownV3Db();
  });

  beforeEach(async () => {
    await v3Connection().del().from('rbac_access_tokens');
    savedCache = DI.get(Configuration)!.get(CACHE_PATH);
    clock = new FakeClock();
    clock.install();
    recorder = recordStatements();
  });

  afterEach(() => {
    recorder.restore();
    clock.uninstall();
    DI.get(Configuration)!.set(CACHE_PATH, savedCache);
  });

  async function world(cache: TokenCacheConfig = { ttlSeconds: 10, maxEntries: 10_000 }) {
    DI.get(Configuration)!.set(CACHE_PATH, cache);
    const identities = new CountingIdentityStore();
    const bus = new InProcessCredentialChangeBus();
    const service = await tokenServiceOver<DbTokenService>({ identities, profiles: new NoTokenProfilesPolicy(), auditor: AuthnAudit.over([]), bus });
    const ctx = (): AuthnContext => clock.ctx({ purpose: 'request' });

    const owner = async (): Promise<IdentityRef> => {
      const ref = identities.add({ login: randomUUID() });
      await insertUserRow(ref.id);
      return ref;
    };
    const mint = async (of: IdentityRef, over: Partial<TokenCreateOptions> = {}) => {
      const r = await service.create(of, { name: 'cached', kind: 'pat', expiresAt: new Date(clock.now().getTime() + DAY), ...over } as TokenCreateOptions, ctx());
      assert.ok(r.ok, 'the token is minted');
      return r;
    };
    /** Validates and reports the statements and status reads it cost. */
    const validate = async (plaintext: string) => {
      recorder.reset();
      const statusBefore = identities.statusCalls;
      const result = await service.validate(plaintext, ctx());
      return { result, statements: [...recorder.statements], statusReads: identities.statusCalls - statusBefore };
    };

    return { identities, bus, service, ctx, owner, mint, validate };
  }

  it('two validates within the ttl issue one token query, and the second reads neither the token nor the status', async () => {
    const w = await world();
    const t = await w.mint(await w.owner());

    const first = await w.validate(t.plaintext);
    assert.ok(first.result.ok);
    assert.strictEqual(first.statements.filter((s) => /rbac_access_tokens/i.test(s)).length, 1, first.statements.join('\n'));
    assert.strictEqual(first.statusReads, 1);

    const second = await w.validate(t.plaintext);
    assert.deepStrictEqual(second.result, first.result);
    assert.deepStrictEqual(second.statements, []);
    assert.strictEqual(second.statusReads, 0);
  });

  it('queries again once the ttl has passed', async () => {
    const w = await world({ ttlSeconds: 10, maxEntries: 10_000 });
    const t = await w.mint(await w.owner());
    assert.ok((await w.validate(t.plaintext)).result.ok);

    clock.tick(10 * SECOND - 1);
    assert.deepStrictEqual((await w.validate(t.plaintext)).statements, [], 'still cached just before the ttl');

    clock.tick(1);
    const after = await w.validate(t.plaintext);
    assert.ok(after.result.ok);
    assert.strictEqual(after.statements.length, 1);
    assert.strictEqual(after.statusReads, 1);
  });

  it('fails revoked right after revoke, revokeById or revokeAllFor in the same process', async () => {
    const w = await world();
    const owner = await w.owner();
    const byOwner = await w.mint(owner);
    const byId = await w.mint(owner);
    const all = await w.mint(owner);
    for (const t of [byOwner, byId, all]) {
      assert.ok((await w.validate(t.plaintext)).result.ok, 'cached before the revoke');
    }

    assert.strictEqual(await w.service.revoke(owner, byOwner.record.id, w.ctx()), true);
    assert.deepStrictEqual((await w.validate(byOwner.plaintext)).result, { ok: false, reason: 'revoked' });

    assert.strictEqual(await w.service.revokeById(byId.record.id, w.ctx()), true);
    assert.deepStrictEqual((await w.validate(byId.plaintext)).result, { ok: false, reason: 'revoked' });

    assert.strictEqual(await w.service.revokeAllFor(owner, w.ctx()), 1);
    assert.deepStrictEqual((await w.validate(all.plaintext)).result, { ok: false, reason: 'revoked' });
  });

  it('publishes each revoke on the bus, so the caches of other services evict too', async () => {
    const w = await world();
    const owner = await w.owner();
    const a = await w.mint(owner);
    const b = await w.mint(owner);
    await w.mint(owner);
    const seen: unknown[] = [];
    w.bus.subscribe((c) => seen.push(c));

    await w.service.revoke(owner, a.record.id, w.ctx());
    await w.service.revokeById(b.record.id, w.ctx());
    await w.service.revokeAllFor(owner, w.ctx());

    assert.deepStrictEqual(seen, [
      { kind: 'token', id: a.record.id },
      { kind: 'token', id: b.record.id },
      { kind: 'identity', identity: owner },
    ]);
  });

  it("a published identity change evicts that owner's entries and keeps the others", async () => {
    const w = await world();
    const alice = await w.owner();
    const bob = await w.owner();
    const pat = await w.mint(alice);
    const agent = await w.mint(alice, { kind: 'agent', expiresAt: new Date(clock.now().getTime() + HOUR), scope: { agent: true } });
    const other = await w.mint(bob);
    for (const t of [pat, agent, other]) {
      assert.ok((await w.validate(t.plaintext)).result.ok);
    }

    await w.bus.publish({ kind: 'identity', identity: alice });

    for (const t of [pat, agent]) {
      const again = await w.validate(t.plaintext);
      assert.ok(again.result.ok);
      assert.strictEqual(again.statements.length, 1, `the ${t.record.kind} token is read again`);
      assert.strictEqual(again.statusReads, 1);
    }
    assert.deepStrictEqual((await w.validate(other.plaintext)).statements, [], "another owner's token stays cached");
  });

  it('a published identity change makes a ban of the owner take effect at once', async () => {
    const w = await world();
    const owner = await w.owner();
    const t = await w.mint(owner);
    assert.ok((await w.validate(t.plaintext)).result.ok);

    w.identities.setStatus(owner, { banned: true });
    await w.bus.publish({ kind: 'identity', identity: owner });

    assert.deepStrictEqual((await w.validate(t.plaintext)).result, { ok: false, reason: 'invalid_credentials' });
  });

  it('a published token change evicts that token', async () => {
    const w = await world();
    const owner = await w.owner();
    const a = await w.mint(owner);
    const b = await w.mint(owner);
    assert.ok((await w.validate(a.plaintext)).result.ok);
    assert.ok((await w.validate(b.plaintext)).result.ok);

    await w.bus.publish({ kind: 'token', id: a.record.id });

    assert.strictEqual((await w.validate(a.plaintext)).statements.length, 1);
    assert.deepStrictEqual((await w.validate(b.plaintext)).statements, []);
  });

  it('a miss reads the token and its owner in one statement that joins users, and the status apart', async () => {
    const w = await world();
    const owner = await w.owner();
    const t = await w.mint(owner);

    const miss = await w.validate(t.plaintext);
    assert.ok(miss.result.ok);
    assert.deepStrictEqual(miss.result.identity, owner);
    assert.strictEqual(miss.statements.length, 1, miss.statements.join('\n'));
    assert.match(miss.statements[0], /rbac_access_tokens/i);
    assert.match(miss.statements[0], /join/i);
    assert.match(miss.statements[0], /users/i);
    assert.strictEqual(miss.statusReads, 1);
  });

  it('an unknown token, or a token whose owner row is gone, fails invalid_credentials in one statement', async () => {
    const w = await world();
    const owner = await w.owner();
    const t = await w.mint(owner);

    const unknown = await w.validate(`spt_${'A'.repeat(43)}`);
    assert.deepStrictEqual(unknown.result, { ok: false, reason: 'invalid_credentials' });
    assert.strictEqual(unknown.statements.length, 1);

    await v3Connection().del().from('users').where({ Uuid: owner.id });
    const orphan = await w.validate(t.plaintext);
    assert.deepStrictEqual(orphan.result, { ok: false, reason: 'invalid_credentials' });
    assert.strictEqual(orphan.statements.length, 1);
    assert.strictEqual(orphan.statusReads, 0);
  });

  it('ttlSeconds 0 turns the cache off', async () => {
    const w = await world({ ttlSeconds: 0, maxEntries: 10_000 });
    const t = await w.mint(await w.owner());
    for (let i = 0; i < 3; i++) {
      const v = await w.validate(t.plaintext);
      assert.ok(v.result.ok);
      assert.strictEqual(v.statements.length, 1);
      assert.strictEqual(v.statusReads, 1);
    }
  });

  it('a cached token still expires at its expiresAt', async () => {
    const w = await world();
    const t = await w.mint(await w.owner(), { expiresAt: new Date(clock.now().getTime() + 5 * SECOND) });
    assert.ok((await w.validate(t.plaintext)).result.ok);

    clock.tick(5 * SECOND);
    assert.deepStrictEqual((await w.validate(t.plaintext)).result, { ok: false, reason: 'expired' });
  });

  it('keeps no result of a validation that a revoke overtook', async () => {
    const w = await world();
    const owner = await w.owner();
    const t = await w.mint(owner);

    let release!: () => void;
    w.identities.gate = new Promise<void>((resolve) => (release = resolve));
    const racing = w.service.validate(t.plaintext, w.ctx());
    // The validation is parked in its status read while the revoke lands.
    while (w.identities.statusCalls === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.strictEqual(await w.service.revoke(owner, t.record.id, w.ctx()), true);
    w.identities.gate = null;
    release();
    await racing;

    assert.deepStrictEqual((await w.validate(t.plaintext)).result, { ok: false, reason: 'revoked' });
  });

  it('serves the stamp touch wrote, so a cached token is not stamped again on every request', async () => {
    const w = await world();
    const t = await w.mint(await w.owner());
    assert.ok((await w.validate(t.plaintext)).result.ok);

    assert.strictEqual(await w.service.touch(t.record.id, w.ctx(), 60), true);
    const cached = await w.validate(t.plaintext);
    assert.deepStrictEqual(cached.statements, []);
    assert.ok(cached.result.ok);
    assert.strictEqual(cached.result.token.lastUsedAt?.getTime(), clock.now().getTime());
    assert.strictEqual(cached.result.token.lastUsedIp, w.ctx().ip);
  });

  it('a rotation evicts the old secret from the cache at once, and the new one is read once and cached', async () => {
    const w = await world();
    const owner = await w.owner();
    const t = await w.mint(owner);
    assert.ok((await w.validate(t.plaintext)).result.ok);
    assert.deepStrictEqual((await w.validate(t.plaintext)).statements, [], 'cached');

    const r = await w.service.rotate(owner, t.record.id, w.ctx());
    assert.ok(r.ok);

    const old = await w.validate(t.plaintext);
    assert.deepStrictEqual(old.result, { ok: false, reason: 'invalid_credentials' });
    assert.strictEqual(old.statements.length, 1, 'one statement for a hash no row holds');

    const fresh = await w.validate(r.plaintext);
    assert.ok(fresh.result.ok);
    assert.strictEqual(fresh.statements.length, 1);
    assert.deepStrictEqual((await w.validate(r.plaintext)).statements, []);
  });

  it('a secret in grace is read in one statement, and cached no longer than the grace', async () => {
    const w = await world({ ttlSeconds: 100, maxEntries: 10_000 });
    const owner = await w.owner();
    const t = await w.mint(owner);
    const r = await w.service.rotate(owner, t.record.id, w.ctx(), { graceSeconds: 60 });
    assert.ok(r.ok);

    const first = await w.validate(t.plaintext);
    assert.ok(first.result.ok);
    assert.strictEqual(first.statements.filter((s) => /rbac_access_tokens/i.test(s)).length, 1, first.statements.join('\n'));
    assert.deepStrictEqual((await w.validate(t.plaintext)).statements, [], 'cached');

    clock.tick(60 * SECOND - 1);
    assert.ok((await w.validate(t.plaintext)).result.ok, 'cached one millisecond before the grace ends');
    clock.tick(1);
    assert.deepStrictEqual((await w.validate(t.plaintext)).result, { ok: false, reason: 'invalid_credentials' });
    assert.ok((await w.validate(r.plaintext)).result.ok, 'the new secret is not tied to the grace');
  });

  it('publishes a revokeByPlaintext on the bus, and a second service on the bus drops its cached secret', async () => {
    const w = await world();
    const other = await tokenServiceOver<DbTokenService>({ identities: w.identities, profiles: new NoTokenProfilesPolicy(), auditor: AuthnAudit.over([]), bus: w.bus });
    const owner = await w.owner();
    const t = await w.mint(owner);
    assert.ok((await other.validate(t.plaintext, w.ctx())).ok, 'cached by the other service');
    assert.ok((await w.validate(t.plaintext)).result.ok, 'cached by the revoking service');
    const seen: unknown[] = [];
    w.bus.subscribe((c) => seen.push(c));

    assert.strictEqual(await w.service.revokeByPlaintext(t.plaintext, w.ctx()), true);
    assert.strictEqual(await w.service.revokeByPlaintext(t.plaintext, w.ctx()), false);
    assert.strictEqual(await w.service.revokeByPlaintext('spt_unknown', w.ctx()), false);

    assert.deepStrictEqual(seen, [{ kind: 'token', id: t.record.id }], 'one change, for the revocation only');
    assert.deepStrictEqual((await w.validate(t.plaintext)).result, { ok: false, reason: 'revoked' });
    assert.deepStrictEqual(await other.validate(t.plaintext, w.ctx()), { ok: false, reason: 'revoked' });
  });

  it('publishes each rotation and update on the bus', async () => {
    const w = await world();
    const owner = await w.owner();
    const t = await w.mint(owner);
    const seen: unknown[] = [];
    w.bus.subscribe((c) => seen.push(c));

    assert.ok((await w.service.rotate(owner, t.record.id, w.ctx(), { graceSeconds: 30 })).ok);
    assert.ok((await w.service.update(owner, t.record.id, { name: 'renamed' }, w.ctx())).ok);
    assert.deepStrictEqual((await w.service.rotate({ type: 'user', id: randomUUID() }, t.record.id, w.ctx())).ok, false);

    assert.deepStrictEqual(seen, [
      { kind: 'token', id: t.record.id },
      { kind: 'token', id: t.record.id },
    ]);
  });

  it('a second service on the same bus drops its cached secret when the first rotates or updates the token', async () => {
    const w = await world();
    const other = await tokenServiceOver<DbTokenService>({ identities: w.identities, profiles: new NoTokenProfilesPolicy(), auditor: AuthnAudit.over([]), bus: w.bus });
    const owner = await w.owner();
    const t = await w.mint(owner, { roles: ['editor', 'viewer'] });
    const ok = async (plaintext: string) => other.validate(plaintext, w.ctx());
    const warm = await ok(t.plaintext);
    assert.ok(warm.ok);

    assert.ok((await w.service.update(owner, t.record.id, { roles: ['viewer'] }, w.ctx())).ok);
    const narrowed = await ok(t.plaintext);
    assert.ok(narrowed.ok);
    assert.deepStrictEqual(narrowed.ceiling?.roles, ['viewer']);

    const r = await w.service.rotate(owner, t.record.id, w.ctx());
    assert.ok(r.ok);
    assert.deepStrictEqual(await ok(t.plaintext), { ok: false, reason: 'invalid_credentials' });
    assert.ok((await ok(r.plaintext)).ok);
  });
});
