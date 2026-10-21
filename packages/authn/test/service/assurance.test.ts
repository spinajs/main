import assert from 'node:assert/strict';
import 'mocha';
import { FakeStrategy } from '@spinajs/authn-testing';

import type { AuthenticationResult, AuthnContext, IdentityRef, StrategyOutcome } from '../../src/index.js';
import { buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

type Success = Extract<AuthenticationResult, { status: 'success' }>;

const IP = '192.0.2.10';
const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), ip: IP, purpose: 'login', ...over });

/** An interactive strategy for `{ kind: 'kit-passkey' }` that answers `outcome` for the identity `u`. */
const passkeyLike = (outcome: Omit<Extract<StrategyOutcome, { ok: true }>, 'ok' | 'identity'> | StrategyOutcome) =>
  new FakeStrategy({
    name: 'kit-passkey',
    kinds: ['kit-passkey'],
    interactive: true,
    keys: () => [{ kind: 'account', value: 'kit-passkey:1' }],
    verify: () => ('ok' in outcome ? outcome : { ok: true, identity: { type: 'user', id: 'u' }, ...outcome }),
  });

describe('DefaultAuthnService: the assurance a strategy reports (D7)', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  async function boot(s: FakeStrategy): Promise<{ p: CoreParts; id: IdentityRef }> {
    parts = await buildCore({}, { strategies: [{ name: s.name, service: 'Svc_kit_passkey', instance: s, listed: true }] });
    return { p: parts, id: parts.identities.add({ id: 'u', login: 'u@example.test' }) };
  }

  it('an interactive login reported at aal2 issues an aal2 session', async () => {
    const { p } = await boot(passkeyLike({ method: 'webauthn', assurance: 'aal2' }));
    const r = await p.service.authenticate({ kind: 'kit-passkey' }, ctx());
    assert.strictEqual(r.status, 'success', JSON.stringify(r));
    const s = r as Success;
    assert.strictEqual(s.facts.assurance, 'aal2');
    assert.strictEqual(s.facts.method, 'webauthn');
    const stored = await p.sessions.restore(s.session!.id);
    assert.strictEqual(stored?.facts.assurance, 'aal2', 'the session keeps it');
    assert.strictEqual((await p.service.principalOf(s)).authn?.assurance, 'aal2');
  });

  it('a login reported at aal1, or with no assurance, stays aal1', async () => {
    for (const outcome of [{ method: 'webauthn', assurance: 'aal1' as const }, { method: 'webauthn' }]) {
      const { p } = await boot(passkeyLike(outcome));
      const r = await p.service.authenticate({ kind: 'kit-passkey' }, ctx());
      assert.strictEqual(r.status, 'success', JSON.stringify(r));
      assert.strictEqual((r as Success).facts.assurance, 'aal1', JSON.stringify(outcome));
      await p.dispose();
      parts = undefined;
    }
  });

  it('refuses an assurance outside aal1 and aal2 as a broken strategy', async () => {
    const { p } = await boot(passkeyLike({ ok: true, identity: { type: 'user', id: 'u' }, method: 'webauthn', assurance: 'aal3' } as unknown as StrategyOutcome));
    const r = await p.service.authenticate({ kind: 'kit-passkey' }, ctx());
    assert.deepStrictEqual({ ...r }, { status: 'failure', reason: 'invalid_credentials' });
    assert.ok(p.events.all().some((e) => e.outcome === 'failure' && e.reason === 'strategy_contract'));
  });
});
