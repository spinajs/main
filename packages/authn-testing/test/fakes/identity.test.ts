import assert from 'node:assert/strict';
import 'mocha';
import { FAKE_DUMMY_HASH, FakeIdentityStore, MemoryPasswordCredentialStore, fakeHash, fakeSeedPort, fakeVerify } from '../../src/fakes/index.js';

describe('FakeIdentityStore', () => {
  it('finds by login or email, case-insensitively, without trimming', async () => {
    const s = new FakeIdentityStore();
    const a = s.add({ login: 'alice', email: 'Alice@Example.test' });
    assert.deepEqual(await s.findByLogin('ALICE'), a);
    assert.deepEqual(await s.findByLogin('alice@example.TEST'), a);
    assert.equal(await s.findByLogin(' alice'), null);
    assert.equal(await s.findByLogin('bob'), null);
    assert.deepEqual(s.calls.findByLogin, ['ALICE', 'alice@example.TEST', ' alice', 'bob']);
  });

  it('defaults to an active identity and applies status changes', async () => {
    const s = new FakeIdentityStore();
    const a = s.add({ login: 'alice' });
    assert.equal(a.type, 'user');
    assert.deepEqual(await s.status(a), { exists: true, active: true, banned: false, deleted: false });
    s.setStatus(a, { banned: true, active: false });
    assert.deepEqual(await s.status(a), { exists: true, active: false, banned: true, deleted: false });
    assert.deepEqual(s.calls.status, [a, a]);
  });

  it('answers exists false for unknown and removed identities', async () => {
    const s = new FakeIdentityStore();
    const a = s.add({ login: 'alice' });
    s.remove(a);
    assert.deepEqual(await s.status(a), { exists: false, active: false, banned: false, deleted: false });
    assert.equal(await s.findByLogin('alice'), null);
    assert.equal((await s.status({ type: 'user', id: 'nope' })).exists, false);
  });

  it('display returns only what is set', async () => {
    const s = new FakeIdentityStore();
    const a = s.add({ login: 'alice', email: 'a@x.test' });
    const b = s.add({ login: 'bob', name: 'Bob' });
    assert.deepEqual(await s.display(a), { email: 'a@x.test' });
    assert.deepEqual(await s.display(b), { name: 'Bob' });
  });

  it('defines provision only with jit', async () => {
    assert.equal(typeof new FakeIdentityStore().provision, 'undefined');
    assert.equal('provision' in new FakeIdentityStore(), false);
    const s = new FakeIdentityStore({ jit: true });
    const ref = await s.provision!({ provider: 'idp', subject: 's1', email: 'new@x.test' });
    assert.deepEqual(await s.findByLogin('new@x.test'), ref);
    const ref2 = await s.provision!({ provider: 'idp', subject: 's2' });
    assert.deepEqual(await s.findByLogin('idp:s2'), ref2);
    assert.equal(s.calls.provision.length, 2);
  });
});

describe('MemoryPasswordCredentialStore and fake hashing', () => {
  it('stores hashes and records writes', async () => {
    const s = new MemoryPasswordCredentialStore();
    const id = { type: 'user', id: 'u1' };
    assert.equal(await s.get(id), null);
    await s.set(id, fakeHash('pw'));
    assert.equal(await s.get(id), fakeHash('pw'));
    assert.deepEqual(s.writes, [{ id, hash: fakeHash('pw') }]);
  });

  it('fakeHash and fakeVerify agree and never hold the password', () => {
    assert.match(fakeHash('pw'), /^fake\$[0-9a-f]{64}$/);
    assert.equal(fakeHash('pw').includes('pw'), false);
    assert.equal(fakeVerify(fakeHash('pw'), 'pw'), true);
    assert.equal(fakeVerify(fakeHash('pw'), 'other'), false);
    assert.equal(fakeVerify(FAKE_DUMMY_HASH, 'authn-testing dummy'), true);
  });
});

describe('fakeSeedPort', () => {
  it('seeds identities with hashed passwords and flags', async () => {
    const identities = new FakeIdentityStore();
    const passwords = new MemoryPasswordCredentialStore();
    const seed = fakeSeedPort(identities, passwords);
    const a = await seed.user({ login: 'alice', email: 'a@x.test', password: 'pw-12345678', status: { active: false } });
    assert.deepEqual(await identities.findByLogin('a@x.test'), a);
    assert.equal(await passwords.get(a), fakeHash('pw-12345678'));
    assert.equal((await identities.status(a)).active, false);
    await seed.setStatus(a, { active: true, banned: true });
    assert.deepEqual(await identities.status(a), { exists: true, active: true, banned: true, deleted: false });
    const b = await seed.user({ login: 'bob' });
    assert.equal(await passwords.get(b), null);
  });
});
