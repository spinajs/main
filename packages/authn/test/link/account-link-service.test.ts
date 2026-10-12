import assert from 'node:assert/strict';
import 'mocha';
import { DI } from '@spinajs/di';
import { fakeHash } from '@spinajs/authn-testing';

import { AccountLinkService, IdentityLinkStore, KeyRegistry } from '../../src/index.js';
import type { AuthnContext, AuthnEvent, Credentials, ExternalSubject, IdentityLink, IdentityRef, KeyRecord, SessionHandle } from '../../src/index.js';
import { bind, buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreOptions, CoreParts } from '../behaviour/harness.js';

const SECOND = 1000;
const T0 = new Date('2026-10-03T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const IP = '192.0.2.10';
const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const BOB = { login: 'bob@example.test', password: 'Bob-Pass-1234' };
const G1: ExternalSubject = { provider: 'kit-g', subject: 'g-alice', email: 'alice@g.example' };

const ctx = (session: SessionHandle, now: Date = T0, over: Partial<AuthnContext> = {}): AuthnContext => ({ now, session, ip: IP, purpose: 'link', ...over });
const pw = (password: string): Credentials => ({ kind: 'password', login: ALICE.login, password });

/** A KeyRegistry that only lists; `keys` are returned for every owner, as a careless implementation might. */
class ListingKeys extends KeyRegistry {
  listCalls = 0;
  keys: readonly KeyRecord[] = [];
  constructor(private readonly broken = false) {
    super();
  }
  async list(): Promise<readonly KeyRecord[]> {
    this.listCalls++;
    if (this.broken) throw new TypeError('db down');
    return this.keys;
  }
  register(): never {
    throw new Error('not used');
  }
  revoke(): never {
    throw new Error('not used');
  }
  byId(): never {
    throw new Error('not used');
  }
  challenge(): never {
    throw new Error('not used');
  }
}

const key = (owner: IdentityRef, over: Partial<KeyRecord> = {}): KeyRecord => ({ alg: 'EdDSA', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' }, kid: `k-${owner.id}`, owner, thumbprint: 't', createdAt: T0, ...over } as KeyRecord);

const withKeys = (registry: KeyRegistry): CoreOptions => ({ register: (c) => bind(c, KeyRegistry, 'TestKeyRegistry', registry) });

describe('AccountLinkService', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  interface Booted {
    p: CoreParts;
    svc: AccountLinkService;
    a: IdentityRef;
    b: IdentityRef;
  }

  async function boot(opts: CoreOptions & { alicePassword?: boolean } = {}): Promise<Booted> {
    parts = await buildCore({}, opts);
    const a = parts.identities.add({ login: ALICE.login });
    if (opts.alicePassword !== false) await parts.passwords.set(a, fakeHash(ALICE.password));
    const b = parts.identities.add({ login: BOB.login });
    await parts.passwords.set(b, fakeHash(BOB.password));
    return { p: parts, svc: await parts.child.resolve(AccountLinkService), a, b };
  }

  const issue = (p: CoreParts, id: IdentityRef, over: { pending?: boolean; impersonator?: IdentityRef } = {}): Promise<SessionHandle> => p.sessions.issue(id, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: T0, ...(over.impersonator ? { impersonator: over.impersonator } : {}) }, over.pending ? { pending: { steps: ['fake'] } } : undefined);

  const events = (p: CoreParts, type: 'identity.link' | 'identity.unlink'): readonly AuthnEvent[] => p.events.ofType(type);

  describe('link', () => {
    it('links a subject from a fresh active session and audits identity.link without the subject', async () => {
      const { p, svc, a } = await boot();
      const s = await issue(p, a);
      const r = await svc.link(s, G1, ctx(s, at(300 * SECOND)));
      assert.ok(r.ok);
      assert.deepStrictEqual(r.link.identity, a);
      assert.deepStrictEqual((await p.links.find('kit-g', 'g-alice'))?.identity, a);
      const [e] = events(p, 'identity.link');
      assert.strictEqual(e.outcome, 'success');
      assert.deepStrictEqual(e.identity, a);
      assert.deepStrictEqual(e.data, { provider: 'kit-g', link: r.link.id });
      assert.strictEqual(e.ip, IP);
      assert.ok(e.session && e.session !== s.id, 'the listed handle, never the raw id');
      assert.ok(!JSON.stringify(p.events.all()).includes('g-alice'), 'the subject never reaches an event');
      assert.ok(!JSON.stringify(p.events.all()).includes(s.id));
    });

    it('refuses a stale session, and links after an inline re-authentication of the same identity', async () => {
      const { p, svc, a } = await boot();
      const s = await issue(p, a);
      const late = ctx(s, at(301 * SECOND));
      assert.deepStrictEqual(await svc.link(s, G1, late), { ok: false });
      assert.deepStrictEqual(await svc.link(s, G1, late, pw('Wrong-Pass-9876')), { ok: false });
      assert.strictEqual(await p.links.find('kit-g', 'g-alice'), null);
      assert.deepStrictEqual(
        events(p, 'identity.link').map((e) => e.reason),
        ['not_fresh', 'not_fresh'],
      );
      const r = await svc.link(s, G1, late, pw(ALICE.password));
      assert.ok(r.ok);
      assert.strictEqual(p.events.ofType('reauth').filter((e) => e.outcome === 'success').length, 1);
    });

    it('refuses a pending, an unknown or a malformed session without writing', async () => {
      const { p, svc, a } = await boot();
      const pending = await issue(p, a, { pending: true });
      const gone: SessionHandle = { id: 'no-such-session', state: 'active' };
      for (const s of [pending, gone, undefined as unknown as SessionHandle, { id: '' } as SessionHandle]) {
        assert.deepStrictEqual(await svc.link(s, G1, ctx(s)), { ok: false });
      }
      assert.strictEqual(p.links.links.length, 0);
      assert.deepStrictEqual(
        events(p, 'identity.link').map((e) => [e.outcome, e.reason]),
        Array(4).fill(['failure', 'not_active']),
      );
    });

    it('refuses while impersonating, even with a fresh session', async () => {
      const { p, svc, a, b } = await boot();
      const s = await issue(p, a, { impersonator: b });
      assert.deepStrictEqual(await svc.link(s, G1, ctx(s)), { ok: false });
      assert.strictEqual(p.links.links.length, 0);
      assert.strictEqual(events(p, 'identity.link')[0].reason, 'impersonating');
    });

    it('refuses a holder whose status no longer allows a login, on link and unlink', async () => {
      const { p, svc, a } = await boot();
      const s = await issue(p, a);
      const l = await p.links.link(a, { provider: 'kit-g', subject: 'g-0' });
      p.identities.setStatus(a, { banned: true });
      assert.deepStrictEqual(await svc.link(s, G1, ctx(s)), { ok: false });
      assert.deepStrictEqual(await svc.unlink(s, l.id, ctx(s)), { ok: false });
      assert.strictEqual(await p.links.find('kit-g', 'g-alice'), null);
      assert.strictEqual((await p.links.list(a)).length, 1);
      assert.deepStrictEqual(
        [...events(p, 'identity.link'), ...events(p, 'identity.unlink')].map((e) => [e.reason, e.identity]),
        [
          ['banned', a],
          ['banned', a],
        ],
      );
      p.identities.remove(a);
      assert.deepStrictEqual(await svc.unlink(s, l.id, ctx(s)), { ok: false });
      assert.strictEqual(events(p, 'identity.unlink')[1].reason, 'unknown_identity');
    });

    it("refuses a context whose purpose is not 'link'", async () => {
      const { p, svc, a } = await boot();
      const s = await issue(p, a);
      for (const purpose of ['login', 'reauth', 'request'] as const) assert.deepStrictEqual(await svc.link(s, G1, ctx(s, T0, { purpose })), { ok: false });
      assert.strictEqual(p.links.links.length, 0);
      assert.deepStrictEqual(new Set(events(p, 'identity.link').map((e) => e.reason)), new Set(['wrong_purpose']));
    });

    it('refuses a subject linked to another identity with a bare { ok: false } and leaves the link with its owner', async () => {
      const { p, svc, a, b } = await boot();
      await p.links.link(b, G1);
      const s = await issue(p, a);
      const r = await svc.link(s, G1, ctx(s));
      assert.deepStrictEqual(r, { ok: false });
      assert.strictEqual(Object.keys(r).length, 1);
      assert.deepStrictEqual((await p.links.find('kit-g', 'g-alice'))?.identity, b);
      const [e] = events(p, 'identity.link');
      assert.deepStrictEqual([e.outcome, e.reason, e.identity], ['failure', 'linked_elsewhere', a]);
    });

    it('refuses a subject already linked to the same identity and keeps one link', async () => {
      const { p, svc, a } = await boot();
      const s = await issue(p, a);
      assert.ok((await svc.link(s, G1, ctx(s))).ok);
      assert.deepStrictEqual(await svc.link(s, G1, ctx(s)), { ok: false });
      assert.strictEqual((await p.links.list(a)).length, 1);
      assert.strictEqual(events(p, 'identity.link')[1].reason, 'already_linked');
    });

    it("maps the store's unique-index error (a parallel link) to a refusal with the error class only", async () => {
      const { p, svc, a, b } = await boot();
      const s = await issue(p, a);
      const store = p.links;
      const original = store.find.bind(store);
      // The check sees no link; another request links the subject before the insert.
      store.find = async (provider, subject) => {
        const r = await original(provider, subject);
        if (r === null) await store.link(b, G1);
        return r;
      };
      assert.deepStrictEqual(await svc.link(s, G1, ctx(s)), { ok: false });
      assert.deepStrictEqual((await original('kit-g', 'g-alice'))?.identity, b);
      const [e] = events(p, 'identity.link');
      assert.deepStrictEqual([e.reason, e.data], ['store_error', { error: 'Error' }]);
      assert.ok(!JSON.stringify(e).includes('duplicate'), 'no message');
    });

    it('refuses a subject without a provider or a subject', async () => {
      const { p, svc, a } = await boot();
      const s = await issue(p, a);
      for (const bad of [{ provider: '', subject: 'x' }, { provider: 'kit-g', subject: '' }, { provider: 'kit-g' }, null]) {
        assert.deepStrictEqual(await svc.link(s, bad as unknown as ExternalSubject, ctx(s)), { ok: false });
      }
      assert.strictEqual(p.links.links.length, 0);
      assert.deepStrictEqual(new Set(events(p, 'identity.link').map((e) => e.reason)), new Set(['invalid_subject']));
    });
  });

  describe('unlink', () => {
    async function linked(opts: CoreOptions & { alicePassword?: boolean } = {}, count = 1): Promise<Booted & { s: SessionHandle; ls: IdentityLink[] }> {
      const booted = await boot(opts);
      const ls: IdentityLink[] = [];
      for (let i = 0; i < count; i++) ls.push(await booted.p.links.link(booted.a, { provider: 'kit-g', subject: `g-${i}` }));
      return { ...booted, s: await issue(booted.p, booted.a), ls };
    }

    it('removes an own link when a password remains and audits identity.unlink', async () => {
      const { p, svc, a, s, ls } = await linked();
      assert.deepStrictEqual(await svc.unlink(s, ls[0].id, ctx(s)), { ok: true });
      assert.strictEqual((await p.links.list(a)).length, 0);
      const [e] = events(p, 'identity.unlink');
      assert.deepStrictEqual([e.outcome, e.identity, e.data], ['success', a, { provider: 'kit-g', link: ls[0].id }]);
    });

    it("is owner-bound: another identity's link id is refused like an unknown one and stays", async () => {
      const { p, svc, b, s } = await linked({}, 2);
      const bobs = await p.links.link(b, { provider: 'kit-g', subject: 'g-bob' });
      assert.deepStrictEqual(await svc.unlink(s, bobs.id, ctx(s)), { ok: false });
      assert.deepStrictEqual(await svc.unlink(s, 'no-such-link', ctx(s)), { ok: false });
      assert.deepStrictEqual((await p.links.find('kit-g', 'g-bob'))?.identity, b);
      assert.deepStrictEqual(
        events(p, 'identity.unlink').map((e) => e.reason),
        ['unknown_link', 'unknown_link'],
      );
    });

    it('lets exactly one of two parallel unlinks of the last two links through', async () => {
      const { p, svc, a, s, ls } = await linked({ alicePassword: false }, 2);
      const out = await Promise.all(ls.map((l) => svc.unlink(s, l.id, ctx(s))));
      assert.deepStrictEqual(out.map((r) => r.ok).sort(), [false, true]);
      assert.strictEqual((await p.links.list(a)).length, 1);
    });

    it('refuses a link store that fails to list, auditing the error class only', async () => {
      const { p, svc, a, s, ls } = await linked();
      const list = p.links.list.bind(p.links);
      p.links.list = async () => {
        throw new TypeError('db down');
      };
      assert.deepStrictEqual(await svc.unlink(s, ls[0].id, ctx(s)), { ok: false });
      p.links.list = list;
      assert.strictEqual((await p.links.list(a)).length, 1);
      const [e] = events(p, 'identity.unlink');
      assert.deepStrictEqual([e.reason, e.data], ['store_error', { error: 'TypeError' }]);
    });

    it('needs the same fresh active session as link', async () => {
      const { p, svc, a, b, s, ls } = await linked();
      const late = ctx(s, at(301 * SECOND));
      assert.deepStrictEqual(await svc.unlink(s, ls[0].id, late), { ok: false });
      const pending = await issue(p, a, { pending: true });
      assert.deepStrictEqual(await svc.unlink(pending, ls[0].id, ctx(pending)), { ok: false });
      const imp = await issue(p, a, { impersonator: b });
      assert.deepStrictEqual(await svc.unlink(imp, ls[0].id, ctx(imp)), { ok: false });
      assert.deepStrictEqual(await svc.unlink(s, ls[0].id, ctx(s, T0, { purpose: 'login' })), { ok: false });
      assert.strictEqual((await p.links.list(a)).length, 1);
      assert.deepStrictEqual(
        events(p, 'identity.unlink').map((e) => e.reason),
        ['not_fresh', 'not_active', 'impersonating', 'wrong_purpose'],
      );
      assert.deepStrictEqual(await svc.unlink(s, ls[0].id, late, pw(ALICE.password)), { ok: true });
    });

    describe('the last usable credential', () => {
      it('refuses the only link without a password, another link or a key registry', async () => {
        const { p, svc, a, s, ls } = await linked({ alicePassword: false });
        assert.deepStrictEqual(await svc.unlink(s, ls[0].id, ctx(s)), { ok: false });
        assert.strictEqual((await p.links.list(a)).length, 1);
        assert.strictEqual(events(p, 'identity.unlink')[0].reason, 'last_credential');
      });

      it('counts no password when no PasswordCredentialStore is registered', async () => {
        const { p, svc, a, s, ls } = await linked({ omit: ['PasswordCredentialStore'] });
        assert.deepStrictEqual(await svc.unlink(s, ls[0].id, ctx(s)), { ok: false });
        assert.strictEqual((await p.links.list(a)).length, 1);
      });

      it('removes one of two links without a password', async () => {
        const { p, svc, a, s, ls } = await linked({ alicePassword: false }, 2);
        assert.deepStrictEqual(await svc.unlink(s, ls[0].id, ctx(s)), { ok: true });
        assert.deepStrictEqual(
          (await p.links.list(a)).map((l) => l.id),
          [ls[1].id],
        );
        assert.deepStrictEqual(await svc.unlink(s, ls[1].id, ctx(s)), { ok: false }, 'now it is the last one');
      });

      it('removes the only link when the registered KeyRegistry lists a usable key of the identity', async () => {
        const registry = new ListingKeys();
        const { p, svc, a, s, ls } = await linked({ alicePassword: false, ...withKeys(registry) });
        registry.keys = [key(a, { expiresAt: at(3600 * SECOND) })];
        assert.deepStrictEqual(await svc.unlink(s, ls[0].id, ctx(s)), { ok: true });
        assert.strictEqual(registry.listCalls, 1);
        assert.strictEqual((await p.links.list(a)).length, 0);
      });

      it('does not count revoked, expired or foreign keys', async () => {
        const registry = new ListingKeys();
        const { p, svc, a, b, s, ls } = await linked({ alicePassword: false, ...withKeys(registry) });
        registry.keys = [key(a, { kid: 'revoked', revokedAt: T0 }), key(a, { kid: 'expired', expiresAt: T0 }), key(b, { kid: 'bobs' }), key({ type: 'service', id: a.id }, { kid: 'service' })];
        assert.deepStrictEqual(await svc.unlink(s, ls[0].id, ctx(s)), { ok: false });
        assert.strictEqual(events(p, 'identity.unlink')[0].reason, 'last_credential');
      });

      it('refuses when a store fails, auditing the error class only', async () => {
        const { p, svc, a, s, ls } = await linked({ alicePassword: false, ...withKeys(new ListingKeys(true)) });
        assert.deepStrictEqual(await svc.unlink(s, ls[0].id, ctx(s)), { ok: false });
        assert.strictEqual((await p.links.list(a)).length, 1);
        const [e] = events(p, 'identity.unlink');
        assert.deepStrictEqual([e.reason, e.data], ['store_error', { error: 'TypeError' }]);
      });

      it('refuses when the password store fails, auditing the error class only', async () => {
        const { p, svc, a, s, ls } = await linked();
        p.passwords.get = async () => {
          throw new RangeError('db down');
        };
        assert.deepStrictEqual(await svc.unlink(s, ls[0].id, ctx(s)), { ok: false });
        assert.strictEqual((await p.links.list(a)).length, 1);
        const [e] = events(p, 'identity.unlink');
        assert.deepStrictEqual([e.reason, e.data], ['store_error', { error: 'RangeError' }]);
      });

      it('does not ask the key registry when a password or another link remains', async () => {
        const registry = new ListingKeys();
        const { svc, s, ls } = await linked(withKeys(registry));
        assert.deepStrictEqual(await svc.unlink(s, ls[0].id, ctx(s)), { ok: true });
        assert.strictEqual(registry.listCalls, 0);
      });
    });
  });

  describe('boot', () => {
    it('fails without an IdentityLinkStore', async () => {
      parts = await buildCore({}, { omit: ['IdentityLinkStore'] });
      await assert.rejects(async () => parts!.child.resolve(AccountLinkService), /IdentityLinkStore/);
    });

    it('fails without a SessionIssuer', async () => {
      parts = await buildCore({}, { omit: ['SessionIssuer'], strategies: [] });
      await assert.rejects(async () => parts!.child.resolve(AccountLinkService), /SessionIssuer.*is not registered at container/);
    });

    it('is one per container (D11)', async () => {
      const { p, svc } = await boot();
      assert.strictEqual(await p.child.resolve(AccountLinkService), svc);
      const other = await buildCore();
      try {
        assert.notStrictEqual(await other.child.resolve(AccountLinkService), svc);
      } finally {
        await other.dispose();
      }
      assert.ok(!DI.RootContainer.isResolved(AccountLinkService), 'nothing resolved in the root');
    });

    it('uses the link store of its container', async () => {
      const { p, svc, a } = await boot();
      const s = await issue(p, a);
      assert.ok((await svc.link(s, G1, ctx(s))).ok);
      assert.ok((await p.child.resolve(IdentityLinkStore)) === p.links);
    });
  });
});
