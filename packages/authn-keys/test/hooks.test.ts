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
