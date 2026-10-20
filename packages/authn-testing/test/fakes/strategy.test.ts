import assert from 'node:assert/strict';
import 'mocha';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { Credentials } from '@spinajs/authn/contracts';
import { FakeClock, FakeIdentityStore, FakeStrategy, MemoryPasswordCredentialStore, fakeHash } from '../../src/fakes/index.js';

const ctx = new FakeClock().ctx({ ip: '192.0.2.10' });

describe('FakeStrategy.password', () => {
  const identities = new FakeIdentityStore();
  const passwords = new MemoryPasswordCredentialStore();
  const alice = identities.add({ login: 'Alice@X.test' });
  const strategy = FakeStrategy.password({ identities, passwords });
  before(() => passwords.set(alice, fakeHash('right')));

  it('declares itself', () => {
    assert.ok(strategy instanceof AuthenticationStrategy);
    assert.deepEqual([strategy.name, strategy.kinds, strategy.interactive], ['local', ['password'], true]);
  });

  it('accepts the right password and refuses the rest alike', async () => {
    assert.deepEqual(await strategy.verify({ kind: 'password', login: 'alice@x.test', password: 'right' }, ctx), { ok: true, identity: alice, method: 'password' });
    const wrong = { ok: false, reason: 'invalid_credentials' };
    assert.deepEqual(await strategy.verify({ kind: 'password', login: 'alice@x.test', password: 'wrong' }, ctx), wrong);
    assert.deepEqual(await strategy.verify({ kind: 'password', login: 'nobody', password: 'right' }, ctx), wrong);
    const noPassword = identities.add({ login: 'nopw' });
    assert.ok(noPassword);
    assert.deepEqual(await strategy.verify({ kind: 'password', login: 'nopw', password: 'x' }, ctx), wrong);
  });

  it('answers unsupported_credentials for another kind', async () => {
    assert.deepEqual(await strategy.verify({ kind: 'bearer', token: 't' }, ctx), { ok: false, reason: 'unsupported_credentials' });
  });

  it('keys by lower-cased login and ip, and records calls', async () => {
    const c: Credentials = { kind: 'password', login: 'Alice@X.test', password: 'x' };
    assert.deepEqual(strategy.throttleKeys(c, ctx), [
      { kind: 'account', value: 'alice@x.test' },
      { kind: 'account-ip', value: 'alice@x.test|192.0.2.10' },
    ]);
    assert.deepEqual(strategy.throttleKeys(c, { ...ctx, ip: undefined })[1].value, 'alice@x.test|');
    assert.equal(strategy.keyCalls.length, 2);
    assert.ok(strategy.verifyCalls.length >= 4);
  });
});

describe('FakeStrategy.bearer', () => {
  const id = { type: 'user', id: 'u1' };
  const strategy = FakeStrategy.bearer({ tokens: new Map([['spt_secret', id]]), attributes: { profile: 'p' } });

  it('declares itself', () => {
    assert.deepEqual([strategy.name, strategy.kinds, strategy.interactive], ['token', ['bearer'], false]);
  });

  it('verifies known tokens with attributes', async () => {
    assert.deepEqual(await strategy.verify({ kind: 'bearer', token: 'spt_secret' }, ctx), { ok: true, identity: id, method: 'token', attributes: { profile: 'p' } });
    assert.deepEqual(await strategy.verify({ kind: 'bearer', token: 'nope' }, ctx), { ok: false, reason: 'invalid_credentials' });
    assert.deepEqual(await strategy.verify({ kind: 'password', login: 'a', password: 'b' }, ctx), { ok: false, reason: 'unsupported_credentials' });
  });

  it('omits attributes when none are configured', async () => {
    const plain = FakeStrategy.bearer({ tokens: new Map([['t', id]]) });
    assert.deepEqual(await plain.verify({ kind: 'bearer', token: 't' }, ctx), { ok: true, identity: id, method: 'token' });
  });

  it('keys are stable and never hold the raw token', () => {
    const keys = strategy.throttleKeys({ kind: 'bearer', token: 'spt_secret' }, ctx);
    assert.equal(keys[0].kind, 'account');
    assert.match(keys[0].value, /^tok:[0-9a-f]{16}$/);
    assert.equal(keys[1].value, `${keys[0].value}|192.0.2.10`);
    assert.equal(JSON.stringify(keys).includes('spt_secret'), false);
    assert.deepEqual(strategy.throttleKeys({ kind: 'bearer', token: 'spt_secret' }, ctx), keys);
  });
});

describe('FakeStrategy.external', () => {
  const ext = { provider: 'fake-idp', subject: 's1', email: 'a@x.test', emailVerified: true };
  const strategy = FakeStrategy.external({ provider: 'fake-idp', subjects: new Map([['s1', ext]]) });

  it('declares itself', () => {
    assert.deepEqual([strategy.name, strategy.kinds, strategy.interactive], ['fake-idp', ['external'], true]);
  });

  it('maps payload.subject to an external subject', async () => {
    assert.deepEqual(await strategy.verify({ kind: 'external', provider: 'fake-idp', payload: { subject: 's1' } }, ctx), { ok: true, external: ext, method: 'oidc' });
    assert.deepEqual(await strategy.verify({ kind: 'external', provider: 'fake-idp', payload: { subject: 'zzz' } }, ctx), { ok: false, reason: 'invalid_credentials' });
    assert.deepEqual(await strategy.verify({ kind: 'bearer', token: 't' }, ctx), { ok: false, reason: 'unsupported_credentials' });
  });

  it('keys by provider and subject', () => {
    assert.deepEqual(strategy.throttleKeys({ kind: 'external', provider: 'fake-idp', payload: { subject: 's1' } }, ctx), [{ kind: 'account', value: 'fake-idp:s1' }]);
    assert.deepEqual(strategy.throttleKeys({ kind: 'bearer', token: 't' }, ctx), []);
  });
});

describe('FakeStrategy constructor', () => {
  it('uses the given hooks and records calls', async () => {
    const s = new FakeStrategy({ name: 'custom', kinds: ['x'], interactive: false, verify: () => ({ ok: false, reason: 'expired' }), keys: () => [{ kind: 'ip', value: '1' }] });
    assert.deepEqual(await s.verify({ kind: 'x' }, ctx), { ok: false, reason: 'expired' });
    assert.deepEqual(s.throttleKeys({ kind: 'x' }, ctx), [{ kind: 'ip', value: '1' }]);
    assert.equal(s.verifyCalls.length, 1);
    assert.equal(s.keyCalls.length, 1);
  });
});
