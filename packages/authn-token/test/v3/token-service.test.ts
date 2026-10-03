import 'mocha';
import { expect } from 'chai';
import { createHash, randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { AuthnEventSink, IdentityStore, RoleSource, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEvent, IdentityRef, IdentityStatus, Principal, TokenCreateOptions, TokenCreateResult } from '@spinajs/authn/contracts';
import { FakeIdentityStore, RecordingEventSink } from '@spinajs/authn-testing';
import { DateTime } from 'luxon';

import { AccessTokenGenerationProvider } from '../../src/generation.js';
import type { IGeneratedToken } from '../../src/generation.js';
import '../../src/generator.js';
import { AccessToken } from '../../src/models/AccessToken.js';
import { DbTokenService, NoTokenProfilesPolicy, TokenOwnerResolver, TokenProfilePolicy, UsersTableTokenOwnerResolver } from '../../src/service/index.js';
import { bootV3Db, insertUserRow, shutdownV3Db, v3Connection } from './db.js';

const TABLE = 'rbac_access_tokens';
const NOW = new Date('2026-10-03T10:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 86_400 * SECOND;

const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const ctx = (now: Date = NOW, over: Partial<AuthnContext> = {}): AuthnContext => ({ now, purpose: 'request', ...over });
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

class TokenTestSink extends RecordingEventSink {}

class StubProfilePolicy extends TokenProfilePolicy {
  public allowed: string[] = [];

  public async allowedProfiles(_owner: IdentityRef): Promise<readonly string[]> {
    return [...this.allowed];
  }
}

class TokenTestIdentityStore extends FakeIdentityStore {}

class ThrowingTokenSink extends AuthnEventSink {
  public async publish(_event: AuthnEvent): Promise<void> {
    throw new Error('sink down');
  }
}

class ViewerRoleSource extends RoleSource {
  public static readonly asked: Principal[] = [];

  public async rolesOf(principal: Principal): Promise<readonly { role: string; requirePassword: boolean }[]> {
    ViewerRoleSource.asked.push(principal);
    return [{ role: 'viewer', requirePassword: false }];
  }
}

class FixedTokenProvider extends AccessTokenGenerationProvider {
  public static plaintext = '';

  public async generate(): Promise<IGeneratedToken> {
    return { Plaintext: FixedTokenProvider.plaintext, Hash: sha256(FixedTokenProvider.plaintext) };
  }

  public hash(plaintext: string): string {
    return sha256(plaintext);
  }
}

type Ok = Extract<TokenCreateResult, { ok: true }>;

describe('DbTokenService', function () {
  this.timeout(15000);

  let identities: FakeIdentityStore;
  let profiles: StubProfilePolicy;
  let tokens: DbTokenService;
  let sink: TokenTestSink;
  const rowIds = new Map<string, number>();
  const savedConfig = new Map<string, unknown>();

  const config = () => DI.get(Configuration)!;
  const setToken = (key: string, value: unknown) => config().set(['authn', 'token', key], value);

  before(async () => {
    await bootV3Db();
    DI.register(TokenTestSink).as(AuthnEventSink);
    for (const key of ['maxTtlDays', 'agentMaxTtlMinutes', 'prefix', 'length']) {
      savedConfig.set(key, config().get(['authn', 'token', key]));
    }
  });

  after(async () => {
    DI.unregister(TokenTestSink);
    DI.uncache(TokenTestSink);
    DI.uncache(Array.ofType(AuthnEventSink));
    await shutdownV3Db();
  });

  beforeEach(() => {
    identities = new FakeIdentityStore();
    profiles = new StubProfilePolicy();
    tokens = new DbTokenService(new UsersTableTokenOwnerResolver(), profiles, identities);
    sink = DI.resolve(Array.ofType(AuthnEventSink)).find((s) => s instanceof TokenTestSink) as TokenTestSink;
    sink.clear();
  });

  afterEach(() => {
    for (const [key, value] of savedConfig) {
      setToken(key, value);
    }
  });

  async function owner(status?: Partial<Omit<IdentityStatus, 'exists'>>): Promise<IdentityRef> {
    const ref = identities.add({ login: randomUUID(), ...(status ? { status } : {}) });
    rowIds.set(ref.id, await insertUserRow(ref.id));
    return ref;
  }

  function create(o: IdentityRef, opts: Record<string, unknown>, c: AuthnContext = ctx()): Promise<TokenCreateResult> {
    return tokens.create(o, opts as unknown as TokenCreateOptions, c);
  }

  async function pat(o: IdentityRef, over: Record<string, unknown> = {}): Promise<Ok> {
    const r = await create(o, { name: 'pat', kind: 'pat', expiresAt: at(DAY), ...over });
    if (!r.ok) {
      throw new Error(`not minted: ${JSON.stringify(r)}`);
    }
    return r;
  }

  async function agent(o: IdentityRef, over: Record<string, unknown> = {}): Promise<Ok> {
    const r = await create(o, { name: 'agent', kind: 'agent', scope: { agent: true }, expiresAt: at(60 * MINUTE), ...over });
    if (!r.ok) {
      throw new Error(`not minted: ${JSON.stringify(r)}`);
    }
    return r;
  }

  async function count(): Promise<number> {
    return ((await v3Connection().select().from(TABLE)) as unknown[]).length;
  }

  async function row(uuid: string): Promise<AccessToken> {
    return AccessToken.where('Uuid', uuid).firstOrFail();
  }

  async function refused(o: IdentityRef, opts: Record<string, unknown>, code: 'invalid_expiry' | 'invalid_scope', label = JSON.stringify(opts)): Promise<void> {
    const before = await count();
    const r = await create(o, opts);
    expect({ ...r }, label).to.deep.equal({ ok: false, code });
    expect(await count(), `${label}: nothing stored`).to.equal(before);
  }

  const validate = (raw: unknown, c: AuthnContext = ctx()) => tokens.validate(raw as string, c);

  describe('create', () => {
    it('mints a prefixed token and stores only its hash', async () => {
      const a = await owner();
      const t = await pat(a, { name: '  ci token  ', roles: ['user', 'user', 'editor'] });

      expect(t.plaintext).to.match(/^spt_[A-Za-z0-9_-]{43}$/);
      expect(t.record).to.deep.equal({
        id: t.record.id,
        owner: a,
        name: 'ci token',
        kind: 'pat',
        roles: ['user', 'editor'],
        createdAt: NOW,
        expiresAt: at(DAY),
      });

      const stored = await row(t.record.id);
      expect(stored.Token).to.equal(sha256(t.plaintext));
      expect(stored.Name).to.equal('ci token');
      expect(stored.Kind).to.equal('pat');
      expect(stored.Roles).to.deep.equal(['user', 'editor']);
      expect(stored.Scope).to.equal(null);
      expect(stored.RevokedAt).to.equal(null);
    });

    // LEDGER actions-crud row 2
    it('stores the given expiry and CreatedAt from ctx.now, not the db default', async () => {
      const a = await owner();
      const t = await pat(a, { expiresAt: at(7 * DAY) });

      const stored = await row(t.record.id);
      expect(stored.ExpiresAt?.toMillis()).to.equal(at(7 * DAY).getTime());
      expect(stored.CreatedAt.toMillis()).to.equal(NOW.getTime());
    });

    // LEDGER actions-crud row 4
    it('binds the token to the owner row found by users.Uuid', async () => {
      const a = await owner();
      const t = await pat(a);
      expect((await row(t.record.id)).user_id).to.equal(rowIds.get(a.id));
    });

    it('SR-08 token without expiry refused', async () => {
      const a = await owner();
      await refused(a, { name: 'no expiry', kind: 'pat' }, 'invalid_expiry');
      await refused(a, { name: 'null expiry', kind: 'pat', expiresAt: null }, 'invalid_expiry');

      // A 2.x row the back-fill has not touched never validates.
      const plaintext = `spt_${'l'.repeat(43)}`;
      const uuid = randomUUID();
      await v3Connection()
        .insert()
        .into(TABLE)
        .values({ Uuid: uuid, Name: 'legacy', Token: sha256(plaintext), Roles: 'user', CreatedAt: DateTime.fromJSDate(at(-DAY)), user_id: rowIds.get(a.id) });

      expect(await validate(plaintext)).to.deep.equal({ ok: false, reason: 'expired' });
      const listed = await tokens.list(a);
      expect(listed.map((r) => [r.id, r.expiresAt.getTime()])).to.deep.equal([[uuid, at(-DAY).getTime()]]);
    });

    it('refuses an expiry that is not a valid Date strictly after ctx.now', async () => {
      const a = await owner();
      const rows: Array<[string, unknown]> = [
        ['NaN date', new Date(Number.NaN)],
        ['string', at(DAY).toISOString()],
        ['number', at(DAY).getTime()],
        ['luxon DateTime', DateTime.fromJSDate(at(DAY))],
        ['now', NOW],
        ['now - 1 ms', at(-1)],
      ];

      for (const [label, expiresAt] of rows) {
        await refused(a, { name: 'x', kind: 'pat', expiresAt }, 'invalid_expiry', label);
      }
    });

    it('accepts exactly maxTtlDays and refuses one millisecond more', async () => {
      const a = await owner();
      await pat(a, { expiresAt: at(90 * DAY) });
      await refused(a, { name: 'x', kind: 'pat', expiresAt: at(90 * DAY + 1) }, 'invalid_expiry');
      await refused(a, { name: 'x', kind: 'service', expiresAt: at(90 * DAY + 1) }, 'invalid_expiry');
    });

    it('reads maxTtlDays at call time', async () => {
      const a = await owner();
      setToken('maxTtlDays', 7);
      await refused(a, { name: 'x', kind: 'pat', expiresAt: at(7 * DAY + 1) }, 'invalid_expiry');
      await pat(a, { expiresAt: at(7 * DAY) });
    });

    it('caps an agent token at agentMaxTtlMinutes, read at call time', async () => {
      const a = await owner();
      await agent(a, { expiresAt: at(1440 * MINUTE) });
      await refused(a, { name: 'x', kind: 'agent', scope: { agent: true }, expiresAt: at(1440 * MINUTE + 1) }, 'invalid_expiry');

      setToken('agentMaxTtlMinutes', 60);
      await agent(a, { expiresAt: at(60 * MINUTE) });
      await refused(a, { name: 'x', kind: 'agent', scope: { agent: true }, expiresAt: at(60 * MINUTE + 1) }, 'invalid_expiry');
    });

    it('refuses an unknown kind', async () => {
      const a = await owner();
      for (const kind of [undefined, 'admin', 'PAT', 1]) {
        await refused(a, { name: 'x', kind, expiresAt: at(DAY) }, 'invalid_scope', `kind ${String(kind)}`);
      }
    });

    it('requires kind and scope.agent to agree', async () => {
      const a = await owner();
      const expiresAt = at(MINUTE);
      const rows: Array<[string, Record<string, unknown>]> = [
        ['agent without scope', { kind: 'agent' }],
        ['agent with scope.agent missing', { kind: 'agent', scope: { permissions: ['file:read'] } }],
        ['agent with scope.agent = "true"', { kind: 'agent', scope: { agent: 'true' } }],
        ['agent with roles', { kind: 'agent', scope: { agent: true }, roles: ['user'] }],
        ['agent with empty roles', { kind: 'agent', scope: { agent: true }, roles: [] }],
        ['agent with a profile', { kind: 'agent', scope: { agent: true }, profile: 'p' }],
        ['pat with scope.agent', { kind: 'pat', scope: { agent: true } }],
        ['service with scope.agent', { kind: 'service', scope: { agent: true } }],
        ['pat with a non-object scope', { kind: 'pat', scope: 'all' }],
        ['pat with an array scope', { kind: 'pat', scope: [] }],
      ];

      for (const [label, opts] of rows) {
        await refused(a, { name: 'x', expiresAt, ...opts }, 'invalid_scope', label);
      }
    });

    it('refuses roles that are empty, malformed or smuggle a second role', async () => {
      const a = await owner();
      const rows: Array<[string, unknown]> = [
        ['empty list', []],
        ['comma', ['user,admin']],
        ['empty name', ['user', '']],
        ['non-string', ['user', 1]],
        ['not an array', 'user'],
        ['null', null],
      ];

      for (const [label, roles] of rows) {
        await refused(a, { name: 'x', kind: 'pat', roles, expiresAt: at(DAY) }, 'invalid_scope', label);
      }
    });

    it('refuses malformed scope limits', async () => {
      const a = await owner();
      const rows: Array<[string, unknown]> = [
        ['permissions not an array', { permissions: 'file:read' }],
        ['empty permission', { permissions: ['file:read', ''] }],
        ['non-string permission', { permissions: [1] }],
        ['resources not an array', { resources: { type: 'file' } }],
        ['resource without type', { resources: [{ id: '1' }] }],
        ['resource with empty type', { resources: [{ type: '' }] }],
        ['resource with a numeric id', { resources: [{ type: 'file', id: 1 }] }],
        ['null resource', { resources: [null] }],
      ];

      for (const [label, scope] of rows) {
        await refused(a, { name: 'x', kind: 'pat', scope, expiresAt: at(DAY) }, 'invalid_scope', label);
      }
    });

    it('stores only the known scope keys and keeps empty lists as given', async () => {
      const a = await owner();
      const t = await pat(a, {
        scope: { permissions: ['file:read'], resources: [{ type: 'file', id: '7', extra: 1 }, { type: 'dir' }], admin: true, agent: false },
      });
      const expected = { permissions: ['file:read'], resources: [{ type: 'file', id: '7' }, { type: 'dir' }] };
      expect(t.record.scope).to.deep.equal(expected);
      expect((await row(t.record.id)).Scope).to.deep.equal(expected);

      const empty = await pat(a, { scope: { permissions: [], resources: [] } });
      expect(empty.record.scope).to.deep.equal({ permissions: [], resources: [] });

      const agentToken = await agent(a, { scope: { agent: true, permissions: ['file:read'], other: 'x' } });
      expect(agentToken.record.scope).to.deep.equal({ agent: true, permissions: ['file:read'] });
    });

    it('pins a profile only when the policy allows it', async () => {
      const a = await owner();
      profiles.allowed = ['editor'];

      const t = await pat(a, { profile: 'editor' });
      expect(t.record.profile).to.equal('editor');
      expect((await row(t.record.id)).Profile).to.equal('editor');

      await refused(a, { name: 'x', kind: 'pat', profile: 'admin', expiresAt: at(DAY) }, 'invalid_scope');
      await refused(a, { name: 'x', kind: 'pat', profile: '', expiresAt: at(DAY) }, 'invalid_scope');
      await refused(a, { name: 'x', kind: 'pat', profile: 7, expiresAt: at(DAY) }, 'invalid_scope');
    });

    it('allows no profile under the default NoTokenProfilesPolicy', async () => {
      const a = await owner();
      tokens = new DbTokenService(new UsersTableTokenOwnerResolver(), new NoTokenProfilesPolicy(), identities);
      await refused(a, { name: 'x', kind: 'pat', profile: 'user', expiresAt: at(DAY) }, 'invalid_scope');
    });

    it('throws InvalidArgument for a bad name and stores nothing', async () => {
      const a = await owner();
      for (const name of ['', '   ', 'n'.repeat(129), undefined, 7]) {
        const before = await count();
        const err = await create(a, { name, kind: 'pat', expiresAt: at(DAY) }).catch((e: unknown) => e);
        expect(err, `name ${JSON.stringify(name)}`).to.be.instanceOf(InvalidArgument);
        expect(await count()).to.equal(before);
      }

      const longest = await pat(a, { name: 'n'.repeat(128) });
      expect(longest.record.name).to.have.length(128);
    });

    it('throws a plain Error for an owner without a users row, or of another type', async () => {
      const ghost = identities.add({ login: 'ghost' });
      const service = identities.add({ login: 'svc', type: 'service' });
      const before = await count();

      for (const o of [ghost, service]) {
        const err = await create(o, { name: 'x', kind: 'pat', expiresAt: at(DAY) }).catch((e: unknown) => e);
        expect(err).to.be.instanceOf(Error);
        expect(err).to.not.be.instanceOf(InvalidArgument);
      }
      expect(await count()).to.equal(before);
    });

    it('reads expiresAt once through Date.prototype.getTime and stores that instant', async () => {
      const a = await owner();
      // getTime() claims one day; the real instant is the constructor's.
      class LyingDate extends Date {
        public getTime(): number {
          return NOW.getTime() + DAY;
        }
      }

      await refused(a, { name: 'x', kind: 'pat', expiresAt: new LyingDate(at(1000 * DAY).getTime()) }, 'invalid_expiry', 'getTime hides an expiry past the cap');
      await refused(a, { name: 'x', kind: 'pat', expiresAt: Object.create(Date.prototype) }, 'invalid_expiry', 'a Date without a time value');

      const t = await pat(a, { expiresAt: new LyingDate(at(2 * DAY).getTime()) });
      expect((await row(t.record.id)).ExpiresAt?.toMillis()).to.equal(at(2 * DAY).getTime());
      expect(t.record.expiresAt.getTime()).to.equal(at(2 * DAY).getTime());
    });

    it('refuses roles longer than the Roles column and more than 1000 permissions or resources', async () => {
      const a = await owner();
      const many = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

      await pat(a, { roles: ['r'.repeat(512)] });
      await pat(a, { scope: { permissions: many(1000), resources: many(1000).map((id) => ({ type: 'file', id })) } });

      const rows: Array<[string, Record<string, unknown>]> = [
        ['one role of 513 characters', { roles: ['r'.repeat(513)] }],
        ['two roles joined to 513 characters', { roles: ['r'.repeat(256), 's'.repeat(256)] }],
        ['1001 permissions', { scope: { permissions: many(1001) } }],
        ['1001 resources', { scope: { resources: many(1001).map((id) => ({ type: 'file', id })) } }],
      ];
      for (const [label, opts] of rows) {
        await refused(a, { name: 'x', kind: 'pat', expiresAt: at(DAY), ...opts }, 'invalid_scope', label);
      }
    });

    it('throws when the generator mints a token without the prefix or the configured length, and stores nothing', async () => {
      const a = await owner();
      const servicePath = ['authn', 'token', 'generation', 'service'];
      const saved = config().get(servicePath);
      DI.register(FixedTokenProvider).as(AccessTokenGenerationProvider);
      config().set(servicePath, 'FixedTokenProvider');

      try {
        for (const plaintext of ['spt_short', `xyz_${'a'.repeat(43)}`, `spt_${'a'.repeat(42)}`, `spt_${'+'.repeat(43)}`, `spt_${'a'.repeat(42)}=`]) {
          FixedTokenProvider.plaintext = plaintext;
          const before = await count();
          const err = await create(a, { name: 'x', kind: 'pat', expiresAt: at(DAY) }).catch((e: unknown) => e);
          expect(err, plaintext).to.be.instanceOf(Error);
          expect(await count(), `${plaintext}: nothing stored`).to.equal(before);
        }

        FixedTokenProvider.plaintext = `spt_${'a'.repeat(43)}`;
        expect((await pat(a)).plaintext).to.equal(FixedTokenProvider.plaintext);
      } finally {
        config().set(servicePath, saved);
        DI.unregister(FixedTokenProvider);
        DI.uncache(FixedTokenProvider);
      }
    });

    describe('roles against a registered RoleSource', () => {
      afterEach(() => {
        DI.unregister(ViewerRoleSource);
        DI.uncache(ViewerRoleSource);
        DI.uncache(RoleSource);
        ViewerRoleSource.asked.length = 0;
      });

      it('refuses a role the owner does not hold and stores nothing', async () => {
        DI.register(ViewerRoleSource).as(RoleSource);
        const a = await owner();

        await refused(a, { name: 'x', kind: 'pat', roles: ['admin'], expiresAt: at(DAY) }, 'invalid_scope', 'pat admin');
        await refused(a, { name: 'x', kind: 'service', roles: ['viewer', 'admin'], expiresAt: at(DAY) }, 'invalid_scope', 'service viewer + admin');
        expect(ViewerRoleSource.asked).to.deep.equal([
          { type: a.type, id: a.id, authenticated: true, source: 'token', attributes: {} },
          { type: a.type, id: a.id, authenticated: true, source: 'token', attributes: {} },
        ]);
      });

      it('accepts roles the owner holds and asks nothing for a token without roles', async () => {
        DI.register(ViewerRoleSource).as(RoleSource);
        const a = await owner();

        expect((await pat(a, { roles: ['viewer'] })).record.roles).to.deep.equal(['viewer']);
        await pat(a);
        await agent(a);
        expect(ViewerRoleSource.asked).to.have.length(1);
      });

      it('stores a role the owner lacks when no RoleSource is registered (authz-rbac drops it at check time)', async () => {
        const a = await owner();
        const t = await pat(a, { roles: ['admin'] });
        expect((await row(t.record.id)).Roles).to.deep.equal(['admin']);
        expect(ViewerRoleSource.asked).to.deep.equal([]);
      });
    });
  });

  describe('an invalid ctx.now', () => {
    const bad: Array<[string, unknown]> = [
      ['NaN date', new Date(Number.NaN)],
      ['ISO string', NOW.toISOString()],
      ['Date without a time value', Object.create(Date.prototype)],
      ['undefined', undefined],
    ];
    const badCtx = (now: unknown): AuthnContext => ({ now: now as Date, purpose: 'request' });

    it('validate answers invalid_credentials', async () => {
      const a = await owner();
      const t = await pat(a);
      for (const [label, now] of bad) {
        expect(await validate(t.plaintext, badCtx(now)), label).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
      }
    });

    it('create throws a plain Error and stores nothing', async () => {
      const a = await owner();
      for (const [label, now] of bad) {
        const before = await count();
        const err = await create(a, { name: 'x', kind: 'pat', expiresAt: at(DAY) }, badCtx(now)).catch((e: unknown) => e);
        expect(err, label).to.be.instanceOf(Error);
        expect(err, label).to.not.be.instanceOf(InvalidArgument);
        expect(await count(), `${label}: nothing stored`).to.equal(before);
      }
    });

    it('revoke throws and leaves the token live', async () => {
      const a = await owner();
      const t = await pat(a);
      sink.clear();
      for (const [label, now] of bad) {
        const err = await tokens.revoke(a, t.record.id, badCtx(now)).catch((e: unknown) => e);
        expect(err, label).to.be.instanceOf(Error);
      }
      expect((await row(t.record.id)).RevokedAt).to.equal(null);
      expect((await validate(t.plaintext)).ok).to.equal(true);
      expect(sink.all()).to.deep.equal([]);
    });

    it('revokeAllFor throws and leaves the tokens live', async () => {
      const a = await owner();
      const t = await pat(a);
      sink.clear();
      for (const [label, now] of bad) {
        const err = await tokens.revokeAllFor(a, badCtx(now)).catch((e: unknown) => e);
        expect(err, label).to.be.instanceOf(Error);
      }
      expect((await row(t.record.id)).RevokedAt).to.equal(null);
      expect((await validate(t.plaintext)).ok).to.equal(true);
      expect(sink.all()).to.deep.equal([]);
    });
  });

  describe('list', () => {
    it('lists live and expired tokens, never revoked ones, hashes or row ids', async () => {
      const a = await owner();
      const b = await owner();
      const live = await pat(a, { name: 'live' });
      const expired = await pat(a, { name: 'expired', expiresAt: at(SECOND) });
      const revoked = await pat(a, { name: 'revoked' });
      await pat(b, { name: 'other' });
      expect(await tokens.revoke(a, revoked.record.id, ctx())).to.equal(true);

      const listed = await tokens.list(a);
      expect(listed.map((r) => r.name).sort()).to.deep.equal(['expired', 'live']);
      expect(listed.find((r) => r.id === live.record.id)).to.deep.equal(live.record);
      expect(listed.find((r) => r.id === expired.record.id)).to.deep.equal(expired.record);

      const json = JSON.stringify(listed);
      for (const secret of [live.plaintext, sha256(live.plaintext), expired.plaintext, sha256(expired.plaintext)]) {
        expect(json).to.not.contain(secret);
      }
      for (const r of listed) {
        expect(Object.keys(r)).to.not.include.members(['Token', 'Id', 'user_id', 'hash']);
      }
    });

    it('omits roles, scope, profile and last use when they are not set', async () => {
      const a = await owner();
      const t = await pat(a);
      const [listed] = await tokens.list(a);
      expect(Object.keys(listed).sort()).to.deep.equal(['createdAt', 'expiresAt', 'id', 'kind', 'name', 'owner']);
      expect(listed).to.deep.equal(t.record);
    });

    it('maps profile, scope and last use when they are set', async () => {
      const a = await owner();
      profiles.allowed = ['editor'];
      const t = await pat(a, { roles: ['user'], profile: 'editor', scope: { permissions: ['file:read'] } });
      await v3Connection()
        .update()
        .in(TABLE)
        .update({ LastUsedAt: DateTime.fromJSDate(at(MINUTE)), LastUsedIp: '192.0.2.1' })
        .where({ Uuid: t.record.id });

      const [listed] = await tokens.list(a);
      expect(listed).to.deep.equal({ ...t.record, lastUsedAt: at(MINUTE), lastUsedIp: '192.0.2.1' });
    });

    it('answers [] for an unknown owner', async () => {
      expect(await tokens.list({ type: 'user', id: randomUUID() })).to.deep.equal([]);
      expect(await tokens.list({ type: 'service', id: 'svc' })).to.deep.equal([]);
    });
  });

  describe('revoke', () => {
    // LEDGER actions-crud row 5
    it('revokes the token with that uuid and stamps RevokedAt from ctx.now', async () => {
      const a = await owner();
      const t = await pat(a);
      const keep = await pat(a);

      expect(await tokens.revoke(a, t.record.id, ctx(at(MINUTE)))).to.equal(true);
      expect((await row(t.record.id)).RevokedAt?.toMillis()).to.equal(at(MINUTE).getTime());
      expect((await row(keep.record.id)).RevokedAt).to.equal(null);
      expect(await validate(t.plaintext)).to.deep.equal({ ok: false, reason: 'revoked' });
    });

    it('is owner-bound and answers false for unknown ids and a second call', async () => {
      const a = await owner();
      const b = await owner();
      const t = await pat(a);

      expect(await tokens.revoke(b, t.record.id, ctx()), 'another owner').to.equal(false);
      expect(await tokens.revoke(a, randomUUID(), ctx()), 'unknown id').to.equal(false);
      expect(await tokens.revoke(a, 7 as unknown as string, ctx()), 'non-string id').to.equal(false);
      expect(await tokens.revoke({ type: 'user', id: randomUUID() }, t.record.id, ctx()), 'unknown owner').to.equal(false);
      expect((await validate(t.plaintext)).ok).to.equal(true);

      expect(await tokens.revoke(a, t.record.id, ctx())).to.equal(true);
      expect(await tokens.revoke(a, t.record.id, ctx()), 'second call').to.equal(false);
    });

    it('revokes an expired token, which then leaves the list', async () => {
      const a = await owner();
      const t = await pat(a, { expiresAt: at(SECOND) });
      expect(await tokens.revoke(a, t.record.id, ctx(at(DAY)))).to.equal(true);
      expect(await tokens.list(a)).to.deep.equal([]);
    });

    it('revokeAllFor ends every unrevoked token of the owner, agent tokens included', async () => {
      const a = await owner();
      const b = await owner();
      const p = await pat(a);
      const g = await agent(a);
      const gone = await pat(a);
      const other = await pat(b);
      expect(await tokens.revoke(a, gone.record.id, ctx())).to.equal(true);

      expect(await tokens.revokeAllFor(a, ctx(at(MINUTE)))).to.equal(2);
      expect((await row(p.record.id)).RevokedAt?.toMillis()).to.equal(at(MINUTE).getTime());
      expect((await row(g.record.id)).RevokedAt?.toMillis()).to.equal(at(MINUTE).getTime());
      expect((await row(gone.record.id)).RevokedAt?.toMillis(), 'the earlier revocation stays').to.equal(NOW.getTime());
      expect((await validate(other.plaintext)).ok).to.equal(true);

      expect(await tokens.revokeAllFor(a, ctx())).to.equal(0);
      expect(await tokens.revokeAllFor({ type: 'user', id: randomUUID() }, ctx())).to.equal(0);
    });
  });

  describe('validate', () => {
    // LEDGER actions-validate rows 2 and 3
    it('answers invalid_credentials for unknown and degenerate input without throwing', async () => {
      for (const raw of ['spt_does-not-exist', '', '   ', undefined, null, 7, {}, ['spt_x']]) {
        expect(await validate(raw), `input ${JSON.stringify(raw)}`).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
      }
    });

    // LEDGER actions-validate row 4
    it('answers expired at and after the expiry', async () => {
      const a = await owner();
      const t = await pat(a, { expiresAt: at(HOUR) });
      expect((await validate(t.plaintext, ctx(at(HOUR - 1)))).ok).to.equal(true);
      expect(await validate(t.plaintext, ctx(at(HOUR)))).to.deep.equal({ ok: false, reason: 'expired' });
      expect(await validate(t.plaintext, ctx(at(HOUR + SECOND)))).to.deep.equal({ ok: false, reason: 'expired' });
    });

    it('checks revocation before expiry', async () => {
      const a = await owner();
      const t = await pat(a, { expiresAt: at(SECOND) });
      await tokens.revoke(a, t.record.id, ctx());
      expect(await validate(t.plaintext, ctx(at(DAY)))).to.deep.equal({ ok: false, reason: 'revoked' });
    });

    // LEDGER actions-validate rows 6, 7 and 8
    for (const [label, status] of [
      ['deactivated', { active: false }],
      ['soft-deleted', { deleted: true }],
      ['banned', { banned: true }],
    ] as const) {
      it(`answers invalid_credentials for a ${label} owner, on every use`, async () => {
        const a = await owner();
        const t = await pat(a);
        const g = await agent(a);
        expect((await validate(t.plaintext)).ok).to.equal(true);

        identities.setStatus(a, status);
        expect(await validate(t.plaintext)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
        expect(await validate(g.plaintext)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });

        identities.setStatus(a, { active: true, banned: false, deleted: false });
        expect((await validate(t.plaintext)).ok).to.equal(true);
      });
    }

    it('answers invalid_credentials when the identity store or the users table lost the owner', async () => {
      const a = await owner();
      const t = await pat(a);
      identities.remove(a);
      expect(await validate(t.plaintext)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });

      const b = await owner();
      const u = await pat(b);
      await v3Connection().update().in(TABLE).update({ user_id: 999_999 }).where({ Uuid: u.record.id });
      expect(await validate(u.plaintext)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
    });

    it('fails a pinned token once its profile is no longer allowed', async () => {
      const a = await owner();
      profiles.allowed = ['editor'];
      const t = await pat(a, { profile: 'editor' });
      expect((await validate(t.plaintext)).ok).to.equal(true);

      profiles.allowed = [];
      expect(await validate(t.plaintext)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
    });

    it('returns the owner, the ceiling and the profile of a personal token', async () => {
      const a = await owner();
      profiles.allowed = ['editor'];
      const t = await pat(a, { roles: ['user'], profile: 'editor', scope: { permissions: ['file:read'], resources: [{ type: 'file', id: '7' }] } });

      expect(await validate(t.plaintext)).to.deep.equal({
        ok: true,
        identity: a,
        method: 'token',
        ceiling: { roles: ['user'], permissions: ['file:read'], resources: [{ type: 'file', id: '7' }] },
        profile: 'editor',
        token: t.record,
      });
    });

    it('omits the ceiling of an unrestricted token and keeps empty lists', async () => {
      const a = await owner();
      const plain = await pat(a, { kind: 'service' });
      expect(await validate(plain.plaintext)).to.deep.equal({ ok: true, identity: a, method: 'token', token: plain.record });

      const empty = await pat(a, { scope: { resources: [] } });
      expect(await validate(empty.plaintext)).to.deep.equal({ ok: true, identity: a, method: 'token', ceiling: { resources: [] }, token: empty.record });
    });

    it('returns an agent identity acting for the owner inside an out_of_scope ceiling', async () => {
      const a = await owner();
      const g = await agent(a, { scope: { agent: true, permissions: ['file:read'], resources: [{ type: 'dir', id: 'd' }] } });

      expect(await validate(g.plaintext)).to.deep.equal({
        ok: true,
        identity: { type: 'agent', id: g.record.id },
        method: 'token',
        ceiling: { permissions: ['file:read'], resources: [{ type: 'dir', id: 'd' }], reason: 'out_of_scope' },
        delegation: { onBehalfOf: a, mode: 'inherit' },
        token: g.record,
      });

      const bare = await agent(a);
      expect(await validate(bare.plaintext)).to.deep.equal({
        ok: true,
        identity: { type: 'agent', id: bare.record.id },
        method: 'token',
        ceiling: { reason: 'out_of_scope' },
        delegation: { onBehalfOf: a, mode: 'inherit' },
        token: bare.record,
      });
    });

    it('writes nothing to the row', async () => {
      const a = await owner();
      const t = await pat(a);
      await validate(t.plaintext);
      const stored = await row(t.record.id);
      expect(stored.LastUsedAt).to.equal(null);
      expect(stored.LastUsedIp).to.equal(null);
    });
  });

  describe('events', () => {
    it('publishes token.create and token.revoke without the plaintext or its hash', async () => {
      const a = await owner();
      const t = await pat(a);
      const g = await agent(a);
      const actor = { type: 'user', id: 'admin-1' };

      expect(await tokens.revoke(a, t.record.id, ctx(at(MINUTE), { ip: '192.0.2.9' }), { actor })).to.equal(true);
      expect(await tokens.revokeAllFor(a, ctx(at(2 * MINUTE)), { actor })).to.equal(1);

      expect(sink.all()).to.deep.equal([
        { type: 'token.create', at: NOW, outcome: 'success', identity: a, data: { token: t.record.id, kind: 'pat' } },
        { type: 'token.create', at: NOW, outcome: 'success', identity: a, data: { token: g.record.id, kind: 'agent' } },
        { type: 'token.revoke', at: at(MINUTE), outcome: 'success', identity: a, actor, ip: '192.0.2.9', data: { token: t.record.id, kind: 'pat' } },
        { type: 'token.revoke', at: at(2 * MINUTE), outcome: 'success', identity: a, actor, data: { count: 1 } },
      ]);

      const json = JSON.stringify(sink.all());
      for (const secret of [t.plaintext, sha256(t.plaintext), g.plaintext, sha256(g.plaintext)]) {
        expect(json).to.not.contain(secret);
      }
    });

    it('publishes nothing on validate, a refused create or a failed revoke', async () => {
      const a = await owner();
      const t = await pat(a);
      sink.clear();

      await validate(t.plaintext);
      await validate('spt_unknown');
      await create(a, { name: 'x', kind: 'pat' });
      await tokens.revoke(a, randomUUID(), ctx());
      expect(sink.all()).to.deep.equal([]);
    });

    it('works with no sink registered', async () => {
      DI.unregister(TokenTestSink);
      DI.uncache(Array.ofType(AuthnEventSink));
      try {
        const a = await owner();
        const t = await pat(a);
        expect(await tokens.revoke(a, t.record.id, ctx())).to.equal(true);
      } finally {
        DI.register(TokenTestSink).as(AuthnEventSink);
      }
    });

    it('keeps a stored token and a completed revoke when a sink throws', async () => {
      DI.register(ThrowingTokenSink).as(AuthnEventSink);
      DI.uncache(Array.ofType(AuthnEventSink));
      try {
        const recording = DI.resolve(Array.ofType(AuthnEventSink)).find((s) => s instanceof TokenTestSink) as TokenTestSink;
        recording.clear();
        const a = await owner();

        const t = await pat(a);
        expect(t.plaintext).to.match(/^spt_/);
        expect((await validate(t.plaintext)).ok).to.equal(true);

        expect(await tokens.revoke(a, t.record.id, ctx())).to.equal(true);
        expect(await validate(t.plaintext)).to.deep.equal({ ok: false, reason: 'revoked' });

        await pat(a);
        expect(await tokens.revokeAllFor(a, ctx())).to.equal(1);

        expect(recording.all().map((e) => e.type)).to.deep.equal(['token.create', 'token.revoke', 'token.create', 'token.revoke']);
      } finally {
        DI.unregister(ThrowingTokenSink);
        DI.uncache(ThrowingTokenSink);
        DI.uncache(Array.ofType(AuthnEventSink));
      }
    });
  });

  describe('wiring', () => {
    afterEach(() => {
      DI.unregister(TokenTestIdentityStore);
      DI.uncache(TokenTestIdentityStore);
      DI.uncache(IdentityStore);
      DI.uncache(DbTokenService);
      DI.uncache(TokenService);
      DI.uncache(TokenOwnerResolver);
      DI.uncache(TokenProfilePolicy);
    });

    it('refuses to start when DI has no IdentityStore to inject', () => {
      expect(() => DI.resolve(TokenService)).to.throw(Error, /IdentityStore/);
      expect(() => new DbTokenService(new UsersTableTokenOwnerResolver(), profiles, {} as IdentityStore)).to.throw(Error, /IdentityStore/);
    });

    it('resolves as the TokenService with the default resolver, profile policy and the registered IdentityStore', async () => {
      DI.register(TokenTestIdentityStore).as(IdentityStore);
      const service = await DI.resolve(TokenService);
      expect(service).to.be.instanceOf(DbTokenService);
      expect(DI.resolve(TokenOwnerResolver)).to.be.instanceOf(UsersTableTokenOwnerResolver);
      expect(DI.resolve(TokenProfilePolicy)).to.be.instanceOf(NoTokenProfilesPolicy);

      const store = DI.resolve(IdentityStore) as TokenTestIdentityStore;
      expect(store).to.be.instanceOf(TokenTestIdentityStore);
      const a = store.add({ login: 'wired' });
      await insertUserRow(a.id);
      const t = await service.create(a, { name: 'wired', kind: 'pat', expiresAt: at(DAY) }, ctx());
      expect(t.ok).to.equal(true);
      expect((await service.validate((t as Ok).plaintext, ctx())).ok).to.equal(true);
      expect(store.calls.status).to.deep.equal([a]);
    });

    it('refuses to start with an empty prefix or fewer than 32 bytes', async () => {
      for (const [key, value] of [
        ['prefix', ''],
        ['length', 16],
      ] as const) {
        setToken(key, value);
        expect(() => new DbTokenService(new UsersTableTokenOwnerResolver(), profiles, identities), `${key} = ${value}`).to.throw(Error);
        setToken(key, savedConfig.get(key));
      }
    });

    it('refuses to mint when the ttl caps are not positive numbers', async () => {
      const a = await owner();
      for (const [key, value] of [
        ['maxTtlDays', 0],
        ['maxTtlDays', 'ninety'],
        ['agentMaxTtlMinutes', -1],
      ] as const) {
        setToken(key, value);
        const before = await count();
        const err = await create(a, { name: 'x', kind: key === 'maxTtlDays' ? 'pat' : 'agent', scope: key === 'maxTtlDays' ? undefined : { agent: true }, expiresAt: at(MINUTE) }).catch((e: unknown) => e);
        expect(err, `${key} = ${value}`).to.be.instanceOf(Error);
        expect(await count(), `${key} = ${value}: nothing stored`).to.equal(before);
        setToken(key, savedConfig.get(key));
      }
    });
  });
});
