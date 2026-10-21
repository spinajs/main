/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- the tamper tests write into hook inputs untyped, as a careless hook would */
import 'mocha';
import assert from 'node:assert/strict';
import { AuthnAudit } from '@spinajs/authn/audit';
import type { AuthnContext, KeyOwner } from '@spinajs/authn/contracts';
import { FakeBackoffThrottle, FakeClock, MemorySecretStore, RecordingEventSink, ScriptedActionHook, generateKeyPair, kitHooks, throttleParams } from '@spinajs/authn-testing';

import { keysOptionsFor } from './support/keys-options.js';
import { DefaultKeyRegistry, MemoryKeyStore } from '../src/registry/index.js';

const SVC: KeyOwner & { type: 'service' } = { type: 'service', id: 'svc' };
const ADMIN = { type: 'user', id: 'admin' };
const CODE = 'not-today';

async function world() {
  const clock = new FakeClock();
  const events = new RecordingEventSink();
  const store = new MemoryKeyStore();
  const hook = new ScriptedActionHook();
  const registry = new DefaultKeyRegistry({ store, secrets: new MemorySecretStore(), throttle: new FakeBackoffThrottle(throttleParams()), audit: AuthnAudit.over([events]), options: keysOptionsFor({ cache: { ttlSeconds: 0, maxEntries: 1 } }), hooks: await kitHooks([hook]) });
  const ctx = (): AuthnContext => clock.ctx();
  const register = () => {
    const kp = generateKeyPair('EdDSA');
    return { kid: kp.kid, result: registry.register({ owner: SVC, actor: ADMIN, jwk: kp.publicJwk, kid: kp.kid }, ctx()) };
  };
  return { events, store, hook, registry, ctx, register };
}

describe('DefaultKeyRegistry action hooks', () => {
  it("register refused answers { ok: false, code: 'refused' } with the hook's code and stores no key", async () => {
    const w = await world();
    w.hook.refuse('authn.key.register', CODE);
    const { kid, result } = w.register();
    assert.deepStrictEqual(await result, { ok: false, code: 'refused', refusal: CODE });
    assert.strictEqual(await w.store.get(kid), null);
    assert.ok(w.events.all().some((e) => e.type === 'key.register' && e.outcome === 'failure' && e.reason === `hook:${CODE}`));
  });

  it("a failing hook on register answers refused with hook_error", async () => {
    const w = await world();
    w.hook.fail('authn.key.register');
    const { kid, result } = w.register();
    assert.deepStrictEqual(await result, { ok: false, code: 'refused', refusal: 'hook_error' });
    assert.strictEqual(await w.store.get(kid), null);
  });

  it('register runs its hooks once the key is checked: an invalid key reaches no hook', async () => {
    const w = await world();
    assert.deepStrictEqual(await w.registry.register({ owner: SVC, actor: ADMIN, jwk: { kty: 'oct' } as never }, w.ctx()), { ok: false, code: 'invalid_key' });
    assert.deepStrictEqual(w.hook.calls(), []);
    const { result } = w.register();
    assert.strictEqual((await result).ok, true);
    assert.deepStrictEqual(
      w.hook.calls('authn.key.register').map((c) => c.phase),
      ['before', 'after'],
    );
  });

  it('a hook writing into the registration in place changes neither the stored scope, name and expiry nor the owner revoked', async () => {
    const w = await world();
    const kp = generateKeyPair('EdDSA');
    const expiresAt = new Date(w.ctx().now.getTime() + 86_400_000);
    w.hook.tamper('authn.key.register', (i) => {
      i.reg.scope.permissions.push('kit:write');
      i.reg.expiresAt.setTime(expiresAt.getTime() + 365 * 86_400_000);
      i.reg.name = 'evil';
      i.ctx.now.setTime(0);
    });
    w.hook.tamper('authn.key.revoke', (i) => {
      i.owner.id = 'other';
    });
    const r = await w.registry.register({ owner: SVC, actor: ADMIN, jwk: kp.publicJwk, kid: kp.kid, name: 'ci', scope: { permissions: ['kit:read'] }, expiresAt }, w.ctx());
    assert.ok(r.ok, JSON.stringify(r));
    const stored = await w.store.get(kp.kid);
    assert.deepStrictEqual(stored?.scope, { permissions: ['kit:read'] });
    assert.strictEqual(stored?.name, 'ci');
    assert.strictEqual(stored?.expiresAt?.getTime(), expiresAt.getTime());
    assert.ok((stored?.createdAt.getTime() ?? 0) > 0);
    assert.strictEqual(await w.registry.revoke(SVC, kp.kid, w.ctx(), { actor: ADMIN }), true);
    assert.ok((await w.store.get(kp.kid))?.revokedAt, 'the key of the owner the caller named is revoked');
    assert.deepStrictEqual(w.hook.landed(), [], 'every write hit a frozen copy');
  });

  it('revoke refused answers false and the key stays usable', async () => {
    const w = await world();
    const { kid, result } = w.register();
    assert.strictEqual((await result).ok, true);
    w.hook.refuse('authn.key.revoke', CODE);
    assert.strictEqual(await w.registry.revoke(SVC, kid, w.ctx(), { actor: ADMIN }), false);
    assert.ok(!(await w.store.get(kid))?.revokedAt);
    assert.ok(w.events.all().some((e) => e.type === 'key.revoke' && e.outcome === 'failure' && e.reason === `hook:${CODE}`));
  });
});
