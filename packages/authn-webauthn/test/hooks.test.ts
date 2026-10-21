/* eslint-disable @typescript-eslint/no-unsafe-member-access -- the tamper tests write into hook inputs untyped, as a careless hook would */
import 'mocha';
import assert from 'node:assert/strict';
import { ActionRefused } from '@spinajs/hooks';
import type { AuthnContext } from '@spinajs/authn/contracts';
import { FakeClock, RecordingEventSink, ScriptedActionHook, kitHooks } from '@spinajs/authn-testing';
import type { SoftAuthenticator } from '@spinajs/authn-testing';

import { MemoryWebAuthnChallengeStore } from '../src/challenge.js';
import { MemoryWebAuthnCredentialStore } from '../src/store/index.js';
import { WebAuthnPasskeyService } from '../src/service/index.js';
import { ALICE, ORIGIN, START, authenticator, webauthnOptions } from './support/fixtures.js';

const CODE = 'not-today';

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('WebAuthnPasskeyService action hooks', function () {
  this.timeout(30000);
  let clock: FakeClock;
  let credentials: MemoryWebAuthnCredentialStore;
  let events: RecordingEventSink;
  let hook: ScriptedActionHook;
  let service: WebAuthnPasskeyService;
  let key: SoftAuthenticator;

  const ctx = (): AuthnContext => clock.ctx({ purpose: 'request' });

  async function register() {
    const { challengeId, options } = await service.registrationOptions(ALICE, ctx());
    return service.register(ALICE, { challengeId, response: key.create(options as never, ORIGIN) }, ctx());
  }

  beforeEach(async () => {
    clock = new FakeClock(START);
    clock.install();
    credentials = new MemoryWebAuthnCredentialStore();
    events = new RecordingEventSink();
    hook = new ScriptedActionHook();
    service = new WebAuthnPasskeyService({ credentials, challenges: new MemoryWebAuthnChallengeStore(), options: webauthnOptions(), identities: null, sinks: [events], hooks: await kitHooks([hook]) });
    key = authenticator('alice');
  });

  afterEach(() => {
    clock.uninstall();
  });

  it('a refused registration throws ActionRefused and leaves the credential store unchanged', async () => {
    hook.refuse('authn.passkey.register', CODE);
    const err = await rejection(register());
    assert.ok(err instanceof ActionRefused && err.code === CODE, String(err));
    assert.deepStrictEqual(await credentials.listFor(ALICE), []);
    assert.ok(events.all().some((e) => e.type === 'passkey.register' && e.outcome === 'failure' && e.reason === `hook:${CODE}`));
  });

  it('the registration hook sees the verified credential id and runs before and after once', async () => {
    const r = await register();
    assert.ok(r.ok);
    const calls = hook.calls('authn.passkey.register');
    assert.deepStrictEqual(
      calls.map((c) => c.phase),
      ['before', 'after'],
    );
    assert.strictEqual(calls[0].input.credentialId, key.credentialId);
  });

  it('an invalid registration reaches no hook', async () => {
    const { challengeId } = await service.registrationOptions(ALICE, ctx());
    assert.deepStrictEqual(await service.register(ALICE, { challengeId, response: {} }, ctx()), { ok: false, code: 'invalid_response' });
    assert.deepStrictEqual(hook.calls(), []);
  });

  it('a hook writing the identity in place does not move the removal to another identity', async () => {
    assert.ok((await register()).ok);
    hook.tamper('authn.passkey.revoke', (i) => {
      i.identity.id = 'someone-else';
    });
    assert.strictEqual(await service.remove(ALICE, key.credentialId, ctx()), true);
    assert.deepStrictEqual(await credentials.listFor(ALICE), []);
    assert.deepStrictEqual(hook.landed(), []);
  });

  it('a refused removal throws ActionRefused and keeps the passkey', async () => {
    assert.ok((await register()).ok);
    hook.refuse('authn.passkey.revoke', CODE);
    assert.ok((await rejection(service.remove(ALICE, key.credentialId, ctx()))) instanceof ActionRefused);
    assert.deepStrictEqual(
      (await credentials.listFor(ALICE)).map((c) => c.credentialId),
      [key.credentialId],
    );
  });
});
