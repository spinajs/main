import 'mocha';
import { expect } from 'chai';
import { createHash, randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthenticationStrategy, AuthnEventSink, IdentityStore, SessionIssuer, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, IdentityRef, StrategyOutcome, TokenCreateOptions, TokenCreateResult, TokenValidation } from '@spinajs/authn/contracts';
import { FakeIdentityStore, MemorySessionIssuer, RecordingEventSink } from '@spinajs/authn-testing';
import { DateTime } from 'luxon';

import '../../src/generator.js';
import { AccessToken } from '../../src/models/AccessToken.js';
import { DbTokenService, TokenProfilePolicy, UsersTableTokenOwnerResolver } from '../../src/service/index.js';
import { TokenStrategy } from '../../src/strategy/TokenStrategy.js';
import { bootV3Db, insertUserRow, shutdownV3Db } from './db.js';

const NOW = new Date('2026-10-03T10:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 86_400 * SECOND;

const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const ctx = (now: Date = NOW, over: Partial<AuthnContext> = {}): AuthnContext => ({ now, purpose: 'request', ...over });
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const bearer = (token: unknown): Credentials => ({ kind: 'bearer', token } as Credentials);
const throttleId = (token: string): string => `token:${sha256(`authn-token-throttle:${token}`).slice(0, 32)}`;

type Ok = Extract<TokenCreateResult, { ok: true }>;

class StrategyTestProfilePolicy extends TokenProfilePolicy {
  public allowed: string[] = [];

  public async allowedProfiles(_owner: IdentityRef): Promise<readonly string[]> {
    return [...this.allowed];
  }
}

class SpyTokenService extends DbTokenService {
  public validated: string[] = [];
  public touched: Array<{ id: string; now: Date; ip?: string; written: boolean }> = [];
  public touchError: Error | null = null;
  /** Hands the strategy a record without lastUsedAt, as two requests racing past the same stale read would see. */
  public staleRecords = false;

  public async validate(raw: string, c: AuthnContext): Promise<TokenValidation> {
    this.validated.push(raw);
    const v = await super.validate(raw, c);
    if (this.staleRecords && v.ok) {
      const { lastUsedAt: _drop, ...token } = v.token;
      return { ...v, token } as TokenValidation;
    }
    return v;
  }

  public async touch(id: string, c: AuthnContext, intervalSeconds: number): Promise<boolean> {
    if (this.touchError) {
      throw this.touchError;
    }
    const written = await super.touch(id, c, intervalSeconds);
    this.touched.push({ id, now: c.now, ...(c.ip !== undefined ? { ip: c.ip } : {}), written });
    return written;
  }
}

class StrategyTestSink extends RecordingEventSink {}
class StrategyTestSessions extends MemorySessionIssuer {}
class StrategyTestIdentityStore extends FakeIdentityStore {}

describe('TokenStrategy', function () {
  this.timeout(15000);

  let identities: FakeIdentityStore;
  let profiles: StrategyTestProfilePolicy;
  let tokens: SpyTokenService;
  let strategy: TokenStrategy;
  const savedConfig = new Map<string, unknown>();

  const config = () => DI.get(Configuration)!;
  const setToken = (key: string, value: unknown) => config().set(['authn', 'token', key], value);

  before(async () => {
    await bootV3Db();
    for (const key of ['prefix', 'length', 'lastUsedUpdateInterval']) {
      savedConfig.set(key, config().get(['authn', 'token', key]));
    }
  });

  after(async () => {
    await shutdownV3Db();
  });

  beforeEach(async () => {
    identities = new FakeIdentityStore();
    profiles = new StrategyTestProfilePolicy();
    tokens = new SpyTokenService(new UsersTableTokenOwnerResolver(), profiles, identities);
    strategy = new TokenStrategy(tokens);
    await strategy.resolve();
  });

  afterEach(() => {
    for (const [key, value] of savedConfig) {
      setToken(key, value);
    }
  });

  async function owner(): Promise<IdentityRef> {
    const ref = identities.add({ login: randomUUID() });
    await insertUserRow(ref.id);
    return ref;
  }

  async function mint(o: IdentityRef, over: Record<string, unknown> = {}): Promise<Ok> {
    const r = await tokens.create(o, { name: 'pat', kind: 'pat', expiresAt: at(DAY), ...over } as unknown as TokenCreateOptions, ctx());
    if (!r.ok) {
      throw new Error(`not minted: ${JSON.stringify(r)}`);
    }
    return r;
  }

  async function row(uuid: string): Promise<AccessToken> {
    return AccessToken.where('Uuid', uuid).firstOrFail();
  }

  const millis = (d: DateTime | undefined | null): number | null => (d ? d.toMillis() : null);

  describe('shape and boot', () => {
    it('is a non-interactive bearer strategy named token', () => {
      expect(strategy).to.be.instanceOf(AuthenticationStrategy);
      expect(strategy.name).to.equal('token');
      expect(strategy.kinds).to.deep.equal(['bearer']);
      expect(strategy.interactive).to.equal(false);
    });

    it('refuses to start with an empty prefix or a length of 31', async () => {
      for (const [key, value] of [
        ['prefix', ''],
        ['length', 31],
      ] as const) {
        setToken(key, value);
        const err = await new TokenStrategy(tokens).resolve().catch((e: unknown) => e);
        expect(err, `${key} = ${value}`).to.be.instanceOf(Error);
        setToken(key, savedConfig.get(key));
      }
    });

    it('refuses to start with a lastUsedUpdateInterval that is not a non-negative number', async () => {
      for (const value of [-1, 'sixty', Number.NaN]) {
        setToken('lastUsedUpdateInterval', value);
        const err = await new TokenStrategy(tokens).resolve().catch((e: unknown) => e);
        expect(err, `interval = ${String(value)}`).to.be.instanceOf(Error);
      }
    });

    describe('through DI', () => {
      afterEach(() => {
        DI.unregister(StrategyTestIdentityStore);
        DI.uncache(StrategyTestIdentityStore);
        DI.uncache(IdentityStore);
        DI.uncache(TokenStrategy);
        DI.uncache(DbTokenService);
        DI.uncache(TokenService);
      });

      it('is registered as an AuthenticationStrategy under the name TokenStrategy', () => {
        expect(DI.getRegisteredTypes(AuthenticationStrategy)).to.include(TokenStrategy);
        expect(TokenStrategy.name).to.equal('TokenStrategy');
      });

      it('resolves with the registered TokenService', async () => {
        DI.register(StrategyTestIdentityStore).as(IdentityStore);
        const resolved = await DI.resolve(TokenStrategy);
        expect(resolved).to.be.instanceOf(TokenStrategy);

        const store = DI.resolve(IdentityStore) as StrategyTestIdentityStore;
        const a = store.add({ login: 'wired-strategy' });
        await insertUserRow(a.id);
        const service = await DI.resolve(TokenService);
        const t = await service.create(a, { name: 'wired', kind: 'pat', expiresAt: at(DAY) }, ctx());
        expect((await resolved.verify(bearer((t as Ok).plaintext), ctx())).ok).to.equal(true);
        expect(store.calls.status).to.deep.equal([a]);
      });

      it('fails at boot when no IdentityStore is registered', async () => {
        const err = await Promise.resolve()
          .then(() => DI.resolve(TokenStrategy))
          .catch((e: unknown) => e);
        expect(err).to.be.instanceOf(Error);
        expect((err as Error).message).to.match(/IdentityStore/);
      });
    });
  });

  describe('credentials outside the token format', () => {
    const rows: Array<[string, unknown]> = [
      ['a password credential', { kind: 'password', login: 'spt_login', password: 'spt_password' }],
      ['a bearer without a token', { kind: 'bearer' }],
      ['a bearer with a numeric token', { kind: 'bearer', token: 7 }],
      ['a bearer with an object token', { kind: 'bearer', token: { startsWith: () => true } }],
      ['a value without the prefix', { kind: 'bearer', token: `abc_${'a'.repeat(43)}` }],
      ['the prefix in another case', { kind: 'bearer', token: `SPT_${'a'.repeat(43)}` }],
      ['a JWT', { kind: 'bearer', token: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl' }],
      ['null', null],
      ['undefined', undefined],
    ];

    for (const [label, c] of rows) {
      it(`${label}: not accepted, no keys, unsupported_credentials, no lookup`, async () => {
        const creds = c as Credentials;
        expect(strategy.accepts(creds)).to.equal(false);
        expect(strategy.throttleKeys(creds, ctx(NOW, { ip: '192.0.2.1' }))).to.deep.equal([]);
        expect(await strategy.verify(creds, ctx())).to.deep.equal({ ok: false, reason: 'unsupported_credentials' });
        expect(tokens.validated).to.deep.equal([]);
      });
    }

    it('reads the prefix from the config at call time', async () => {
      const token = `key_${'a'.repeat(43)}`;
      expect(strategy.accepts(bearer(token))).to.equal(false);
      setToken('prefix', 'key_');
      expect(strategy.accepts(bearer(token))).to.equal(true);
    });
  });

  describe('throttle keys', () => {
    it('answers account and account-ip keys from a domain-separated hash of the token', () => {
      const token = `spt_${'k'.repeat(43)}`;
      const id = throttleId(token);
      expect(id).to.match(/^token:[0-9a-f]{32}$/);

      expect(strategy.throttleKeys(bearer(token), ctx(NOW, { ip: '192.0.2.1' }))).to.deep.equal([
        { kind: 'account', value: id },
        { kind: 'account-ip', value: `${id}|192.0.2.1` },
      ]);
      expect(strategy.throttleKeys(bearer(token), ctx())).to.deep.equal([
        { kind: 'account', value: id },
        { kind: 'account-ip', value: `${id}|` },
      ]);
    });

    it('is stable across calls, differs per token and carries neither the plaintext nor its SHA-256', async () => {
      const a = await owner();
      const t = await mint(a);
      const other = await mint(a);
      const c = ctx(NOW, { ip: '192.0.2.1' });

      const keys = strategy.throttleKeys(bearer(t.plaintext), c);
      expect(strategy.throttleKeys(bearer(t.plaintext), c)).to.deep.equal(keys);
      expect(strategy.throttleKeys(bearer(other.plaintext), c)).to.not.deep.equal(keys);

      for (const key of keys) {
        expect(key.value).to.not.contain(t.plaintext);
        expect(key.value).to.not.contain(t.plaintext.slice(4));
        expect(key.value).to.not.contain(sha256(t.plaintext));
        expect(key.value).to.not.contain(sha256(t.plaintext).slice(0, 32));
      }
      expect(tokens.validated).to.deep.equal([]);
    });
  });

  describe('verify', () => {
    it('answers the owner, method token and the ceiling of a personal token', async () => {
      const a = await owner();
      const t = await mint(a, { roles: ['user'], scope: { permissions: ['file:read'], resources: [{ type: 'file', id: '7' }] } });

      const outcome = await strategy.verify(bearer(t.plaintext), ctx());
      expect(outcome).to.deep.equal({
        ok: true,
        identity: a,
        method: 'token',
        ceiling: { roles: ['user'], permissions: ['file:read'], resources: [{ type: 'file', id: '7' }] },
      });
      expect(tokens.validated).to.deep.equal([t.plaintext]);
    });

    it('omits the ceiling of an unrestricted token', async () => {
      const a = await owner();
      const t = await mint(a, { kind: 'service' });
      expect(await strategy.verify(bearer(t.plaintext), ctx())).to.deep.equal({ ok: true, identity: a, method: 'token' });
    });

    it('carries a pinned profile as attributes.profile', async () => {
      const a = await owner();
      profiles.allowed = ['editor'];
      const t = await mint(a, { roles: ['editor'], profile: 'editor' });

      expect(await strategy.verify(bearer(t.plaintext), ctx())).to.deep.equal({
        ok: true,
        identity: a,
        method: 'token',
        ceiling: { roles: ['editor'] },
        attributes: { profile: 'editor' },
      });
    });

    it('copies the delegation and ceiling of an agent token', async () => {
      const a = await owner();
      const g = await mint(a, { name: 'agent', kind: 'agent', scope: { agent: true, permissions: ['file:read'] }, expiresAt: at(MINUTE * 60) });

      expect(await strategy.verify(bearer(g.plaintext), ctx())).to.deep.equal({
        ok: true,
        identity: { type: 'agent', id: g.record.id },
        method: 'token',
        ceiling: { permissions: ['file:read'], reason: 'out_of_scope' },
        delegation: { onBehalfOf: a, mode: 'inherit' },
      });
    });

    it('never carries the token record, the plaintext or the hash', async () => {
      const a = await owner();
      profiles.allowed = ['editor'];
      const t = await mint(a, { roles: ['editor'], profile: 'editor', scope: { permissions: ['file:read'] } });

      const outcome = await strategy.verify(bearer(t.plaintext), ctx(NOW, { ip: '192.0.2.1' }));
      expect(Object.keys(outcome).sort()).to.deep.equal(['attributes', 'ceiling', 'identity', 'method', 'ok']);
      const json = JSON.stringify(outcome);
      for (const secret of [t.plaintext, sha256(t.plaintext), t.record.id, t.record.name]) {
        expect(json).to.not.contain(secret);
      }
    });

    describe('failures keep the validation reason and nothing else', () => {
      const failed = async (outcome: Promise<StrategyOutcome>, reason: string, label: string) => {
        expect({ ...(await outcome) }, label).to.deep.equal({ ok: false, reason });
      };

      it('unknown, revoked, expired and banned-owner tokens', async () => {
        const a = await owner();
        const unknown = `spt_${'u'.repeat(43)}`;
        await failed(strategy.verify(bearer(unknown), ctx()), 'invalid_credentials', 'unknown');

        const revoked = await mint(a);
        expect(await tokens.revoke(a, revoked.record.id, ctx())).to.equal(true);
        await failed(strategy.verify(bearer(revoked.plaintext), ctx()), 'revoked', 'revoked');

        const expired = await mint(a, { expiresAt: at(MINUTE) });
        await failed(strategy.verify(bearer(expired.plaintext), ctx(at(MINUTE))), 'expired', 'expired');

        const banned = await mint(a);
        identities.setStatus(a, { banned: true });
        await failed(strategy.verify(bearer(banned.plaintext), ctx()), 'invalid_credentials', 'banned owner');

        expect(tokens.validated).to.deep.equal([unknown, revoked.plaintext, expired.plaintext, banned.plaintext]);
        expect(tokens.touched).to.deep.equal([]);
        for (const t of [revoked, expired, banned]) {
          expect(millis((await row(t.record.id)).LastUsedAt), t.record.name).to.equal(null);
        }
      });
    });

    it('lets an infrastructure error through', async () => {
      tokens.validate = async () => {
        throw new Error('db down');
      };
      const err = await strategy.verify(bearer(`spt_${'d'.repeat(43)}`), ctx()).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(Error);
      expect((err as Error).message).to.equal('db down');
    });
  });

  describe('last-used stamp', () => {
    it('stamps the first use, skips a use inside the interval and stamps again after it', async () => {
      const a = await owner();
      const t = await mint(a);
      const c = bearer(t.plaintext);

      expect((await strategy.verify(c, ctx(NOW, { ip: '192.0.2.1' }))).ok).to.equal(true);
      let stored = await row(t.record.id);
      expect(millis(stored.LastUsedAt)).to.equal(NOW.getTime());
      expect(stored.LastUsedIp).to.equal('192.0.2.1');

      expect((await strategy.verify(c, ctx(at(60 * SECOND), { ip: '192.0.2.2' }))).ok).to.equal(true);
      stored = await row(t.record.id);
      expect(millis(stored.LastUsedAt), 'exactly the interval later').to.equal(NOW.getTime());
      expect(stored.LastUsedIp).to.equal('192.0.2.1');

      expect((await strategy.verify(c, ctx(at(60 * SECOND + 1), { ip: '192.0.2.3' }))).ok).to.equal(true);
      stored = await row(t.record.id);
      expect(millis(stored.LastUsedAt)).to.equal(at(60 * SECOND + 1).getTime());
      expect(stored.LastUsedIp).to.equal('192.0.2.3');

      expect(tokens.touched.map((x) => x.written)).to.deep.equal([true, true]);
    });

    it('reads lastUsedUpdateInterval at call time', async () => {
      const a = await owner();
      const t = await mint(a);
      const c = bearer(t.plaintext);
      await strategy.verify(c, ctx());

      setToken('lastUsedUpdateInterval', 5);
      await strategy.verify(c, ctx(at(6 * SECOND)));
      expect(millis((await row(t.record.id)).LastUsedAt)).to.equal(at(6 * SECOND).getTime());
    });

    it('stores a null ip when the context has none and cuts a long one to 64 characters', async () => {
      const a = await owner();
      const t = await mint(a);
      await strategy.verify(bearer(t.plaintext), ctx());
      expect((await row(t.record.id)).LastUsedIp).to.equal(null);

      const long = `2001:db8::${'f'.repeat(80)}`;
      await strategy.verify(bearer(t.plaintext), ctx(at(DAY / 2), { ip: long }));
      expect((await row(t.record.id)).LastUsedIp).to.equal(long.slice(0, 64));
    });

    it('writes at most once per interval when requests race past the same stale record', async () => {
      const a = await owner();
      const t = await mint(a);
      tokens.staleRecords = true;

      await strategy.verify(bearer(t.plaintext), ctx(NOW, { ip: '192.0.2.1' }));
      await strategy.verify(bearer(t.plaintext), ctx(at(SECOND), { ip: '192.0.2.2' }));

      const stored = await row(t.record.id);
      expect(millis(stored.LastUsedAt)).to.equal(NOW.getTime());
      expect(stored.LastUsedIp).to.equal('192.0.2.1');
      expect(tokens.touched.map((x) => x.written)).to.deep.equal([true, false]);
    });

    it('answers ok when the stamp throws', async () => {
      const a = await owner();
      const t = await mint(a, { roles: ['user'] });
      tokens.touchError = new Error('stamp failed');

      expect(await strategy.verify(bearer(t.plaintext), ctx())).to.deep.equal({ ok: true, identity: a, method: 'token', ceiling: { roles: ['user'] } });
      expect(millis((await row(t.record.id)).LastUsedAt)).to.equal(null);
    });

    it('skips the stamp for a TokenService that cannot record use', async () => {
      const a = await owner();
      const t = await mint(a);
      const plain: TokenService = { validate: (raw: string, c: AuthnContext) => tokens.validate(raw, c) } as unknown as TokenService;
      const s = new TokenStrategy(plain);
      await s.resolve();

      expect((await s.verify(bearer(t.plaintext), ctx())).ok).to.equal(true);
      expect(tokens.touched).to.deep.equal([]);
    });
  });

  describe('side effects', () => {
    let sink: StrategyTestSink;
    let sessions: StrategyTestSessions;

    before(() => {
      DI.register(StrategyTestSink).as(AuthnEventSink);
      DI.register(StrategyTestSessions).as(SessionIssuer);
    });

    after(() => {
      DI.unregister(StrategyTestSink);
      DI.unregister(StrategyTestSessions);
      DI.uncache(StrategyTestSink);
      DI.uncache(StrategyTestSessions);
      DI.uncache(SessionIssuer);
      DI.uncache(Array.ofType(AuthnEventSink));
    });

    it('verify publishes no event and issues no session', async () => {
      sink = DI.resolve(Array.ofType(AuthnEventSink)).find((s) => s instanceof StrategyTestSink) as StrategyTestSink;
      sessions = DI.resolve(SessionIssuer) as StrategyTestSessions;
      const a = await owner();
      const t = await mint(a);
      sink.clear();

      await strategy.verify(bearer(t.plaintext), ctx());
      await strategy.verify(bearer(`spt_${'u'.repeat(43)}`), ctx());
      await strategy.verify(bearer('eyJ.eyJ.sig'), ctx());

      expect(sink.all()).to.deep.equal([]);
      expect(await sessions.storage.storedKeys()).to.deep.equal([]);
    });
  });
});

describe('DbTokenService.touch', function () {
  this.timeout(15000);

  let tokens: DbTokenService;

  before(async () => {
    await bootV3Db();
  });

  after(async () => {
    await shutdownV3Db();
  });

  it('writes LastUsedAt and LastUsedIp only when the stored stamp is absent or older than the interval', async () => {
    const identities = new FakeIdentityStore();
    tokens = new DbTokenService(new UsersTableTokenOwnerResolver(), new StrategyTestProfilePolicy(), identities);
    const a = identities.add({ login: randomUUID() });
    await insertUserRow(a.id);
    const t = (await tokens.create(a, { name: 'touch', kind: 'pat', expiresAt: at(DAY) }, ctx())) as Ok;

    expect(await tokens.touch(t.record.id, ctx(NOW, { ip: '192.0.2.1' }), 60)).to.equal(true);
    expect(await tokens.touch(t.record.id, ctx(at(SECOND), { ip: '192.0.2.2' }), 60)).to.equal(false);
    expect(await tokens.touch(t.record.id, ctx(at(60 * SECOND)), 60)).to.equal(false);

    let stored = await AccessToken.where('Uuid', t.record.id).firstOrFail();
    expect(stored.LastUsedAt?.toMillis()).to.equal(NOW.getTime());
    expect(stored.LastUsedIp).to.equal('192.0.2.1');

    expect(await tokens.touch(t.record.id, ctx(at(61 * SECOND)), 60)).to.equal(true);
    stored = await AccessToken.where('Uuid', t.record.id).firstOrFail();
    expect(stored.LastUsedAt?.toMillis()).to.equal(at(61 * SECOND).getTime());
    expect(stored.LastUsedIp).to.equal(null);

    expect(await tokens.touch(randomUUID(), ctx(), 60), 'unknown id').to.equal(false);
  });

  it('refuses an invalid ctx.now or interval', async () => {
    const identities = new FakeIdentityStore();
    tokens = new DbTokenService(new UsersTableTokenOwnerResolver(), new StrategyTestProfilePolicy(), identities);
    for (const [now, interval] of [
      [new Date(Number.NaN), 60],
      [NOW, -1],
      [NOW, Number.NaN],
      [NOW, '60'],
    ] as const) {
      const err = await tokens.touch(randomUUID(), { now: now as Date, purpose: 'request' }, interval as number).catch((e: unknown) => e);
      expect(err, `${String(now)} / ${String(interval)}`).to.be.instanceOf(Error);
    }
  });
});
