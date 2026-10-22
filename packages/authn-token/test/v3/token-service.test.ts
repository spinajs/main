import 'mocha';
import { expect } from 'chai';
import { createHash, randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { AuthnAudit } from '@spinajs/authn/audit';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { AuthnEventSink, CredentialChangeBus, IdentityStore, RoleSource, TokenService } from '@spinajs/authn/contracts';
import type { AuthnAuditor } from '@spinajs/authn/audit';
import type { AuthnContext, AuthnEvent, IdentityRef, IdentityStatus, Principal, TokenCreateOptions, TokenCreateResult } from '@spinajs/authn/contracts';
import { FakeIdentityStore, RecordingEventSink, kitHooks } from '@spinajs/authn-testing';
import { ActionHook, ActionHookFailed } from '@spinajs/hooks';
import type { ActionName, ActionPattern, BeforeContext } from '@spinajs/hooks';
import { DateTime } from 'luxon';

import { AccessTokenGenerationProvider } from '../../src/generation.js';
import type { IGeneratedToken } from '../../src/generation.js';
import '../../src/generator.js';
import { AccessToken } from '../../src/models/AccessToken.js';
import { DbTokenService, NoTokenProfilesPolicy, TOKEN_PROFILE_HOOK_ORDER, TokenOwnerResolver, TokenProfileHook, TokenProfilePolicy, UsersTableTokenOwnerResolver } from '../../src/service/index.js';
import { bootV3Db, insertUserRow, shutdownV3Db, v3Connection } from './db.js';
import { profileHookIn, tokenServiceOver } from './services.js';
import { setPastSchema } from '../support/config-boot.js';

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

class HangingTokenSink extends AuthnEventSink {
  public publish(_event: AuthnEvent): Promise<void> {
    return new Promise(() => undefined);
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
  const setTokenPastSchema = (key: string, value: unknown) => setPastSchema(config(), `authn.token.${key}`, value);

  before(async () => {
    await bootV3Db();
    for (const key of ['maxTtlDays', 'agentMaxTtlMinutes', 'prefix', 'length']) {
      savedConfig.set(key, config().get(['authn', 'token', key]));
    }
  });

  after(async () => {
    await shutdownV3Db();
  });

  beforeEach(async () => {
    identities = new FakeIdentityStore();
    profiles = new StubProfilePolicy();
    sink = new TokenTestSink();
    tokens = await build();
  });

  afterEach(() => {
    for (const [key, value] of savedConfig) {
      setToken(key, value);
    }
  });

  /** What the code that changes an identity does, so cached validations see the change. */
  async function identityChanged(who: IdentityRef): Promise<void> {
    await (await DI.resolve(CredentialChangeBus)).publish({ kind: 'identity', identity: who });
  }

  function build(over: { profiles?: TokenProfilePolicy; auditor?: AuthnAuditor } = {}): Promise<DbTokenService> {
    return tokenServiceOver({ identities, profiles: over.profiles ?? profiles, auditor: over.auditor ?? AuthnAudit.over([sink]) });
  }

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

      // A row without an expiry never validates.
      const plaintext = `spt_${'l'.repeat(43)}`;
      const uuid = randomUUID();
      await v3Connection()
        .insert()
        .into(TABLE)
        .values({ Uuid: uuid, Name: 'no expiry', Token: sha256(plaintext), Roles: 'user', CreatedAt: DateTime.fromJSDate(at(-DAY)), user_id: rowIds.get(a.id) });

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
      tokens = await build({ profiles: new NoTokenProfilesPolicy() });
      await refused(a, { name: 'x', kind: 'pat', profile: 'user', expiresAt: at(DAY) }, 'invalid_scope');
    });

    describe('the profile check: TokenProfileHook, a before hook on authn.token.create', () => {
      /** An application hook of the default order: records the profiles it is asked about. */
      class SeenProfiles extends ActionHook {
        readonly actions: readonly ActionPattern[] = ['authn.token.create'];
        readonly seen: unknown[] = [];
        before(c: BeforeContext<ActionName>): void {
          this.seen.push((c.input as unknown as { opts: { profile?: unknown } }).opts.profile);
        }
      }

      const withHooks = async (...hooks: ActionHook[]) => tokenServiceOver({ identities, profiles, auditor: AuthnAudit.over([sink]), hooks: await kitHooks(hooks) });

      it('is registered as an ActionHook, before the hooks of the default order', () => {
        expect(DI.RootContainer.getRegisteredTypes(ActionHook) ?? []).to.include(TokenProfileHook);
        const hook = new TokenProfileHook();
        expect([...hook.actions]).to.deep.equal(['authn.token.create']);
        expect(hook.order).to.equal(TOKEN_PROFILE_HOOK_ORDER);
        expect(hook.order).to.be.below(0);
      });

      it('answers a refused profile invalid_scope, audits nothing, and no later hook sees it', async () => {
        const a = await owner();
        profiles.allowed = ['editor'];
        const seen = new SeenProfiles();
        const child = DI.child();
        child.register(() => profiles).as(TokenProfilePolicy);
        tokens = await withHooks(profileHookIn(child), seen);
        sink.clear();

        await refused(a, { name: 'x', kind: 'pat', profile: 'admin', expiresAt: at(DAY) }, 'invalid_scope');
        expect(sink.all()).to.deep.equal([]);
        expect(seen.seen).to.deep.equal([]);

        await pat(a, { profile: 'editor' });
        expect(seen.seen).to.deep.equal(['editor']);
      });

      it('is the only create-time check: without it any profile is pinned, and validate still refuses the token', async () => {
        const a = await owner();
        profiles.allowed = [];
        tokens = await withHooks();

        const t = await pat(a, { profile: 'admin' });
        expect(t.record.profile).to.equal('admin');
        expect(await validate(t.plaintext)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
        await refused(a, { name: 'x', kind: 'pat', profile: 7, expiresAt: at(DAY) }, 'invalid_scope');
      });

      it('a policy that throws fails the create closed', async () => {
        const a = await owner();
        const child = DI.child();
        child.register(() => ({ allowedProfiles: async () => Promise.reject(new Error('policy down')) })).as(TokenProfilePolicy);
        tokens = await withHooks(profileHookIn(child));
        const before = await count();

        let error: unknown;
        try {
          await create(a, { name: 'x', kind: 'pat', profile: 'editor', expiresAt: at(DAY) });
        } catch (e) {
          error = e;
        }
        expect(error).to.be.instanceOf(ActionHookFailed);
        expect(await count()).to.equal(before);
        // A token without a profile does not ask the policy.
        await pat(a);
      });
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

    it('throws InvalidOperation for an owner without a users row, or of another type', async () => {
      const ghost = identities.add({ login: 'ghost' });
      const service = identities.add({ login: 'svc', type: 'service' });
      const before = await count();

      for (const o of [ghost, service]) {
        const err = await create(o, { name: 'x', kind: 'pat', expiresAt: at(DAY) }).catch((e: unknown) => e);
        expect(err).to.be.instanceOf(InvalidOperation);
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
        tokens = await build();
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
      let scope: IContainer | undefined;

      // The RoleSource is injected when DI builds the service, so these tests resolve it instead of new-ing it.
      async function resolveWithRoleSource(): Promise<void> {
        DI.register(ViewerRoleSource).as(RoleSource);
        scope = DI.child();
        scope.register(() => profiles).as(TokenProfilePolicy);
        scope.register(() => identities).as(IdentityStore);
        scope.register(DbTokenService).asSelf();
        tokens = await scope.resolve(DbTokenService);
      }

      afterEach(async () => {
        await scope?.dispose();
        scope = undefined;
        DI.unregister(ViewerRoleSource);
        DI.uncache(ViewerRoleSource);
        DI.uncache(RoleSource);
        ViewerRoleSource.asked.length = 0;
      });

      it('refuses a role the owner does not hold and stores nothing', async () => {
        await resolveWithRoleSource();
        const a = await owner();

        await refused(a, { name: 'x', kind: 'pat', roles: ['admin'], expiresAt: at(DAY) }, 'invalid_scope', 'pat admin');
        await refused(a, { name: 'x', kind: 'service', roles: ['viewer', 'admin'], expiresAt: at(DAY) }, 'invalid_scope', 'service viewer + admin');
        expect(ViewerRoleSource.asked).to.deep.equal([
          { type: a.type, id: a.id, authenticated: true, source: 'token', attributes: {} },
          { type: a.type, id: a.id, authenticated: true, source: 'token', attributes: {} },
        ]);
      });

      it('accepts roles the owner holds and asks nothing for a token without roles', async () => {
        await resolveWithRoleSource();
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

      it('stores the roles as given when DI injects the bare RoleSource it recorded for an unregistered one', async () => {
        DI.register(RoleSource).as(RoleSource);
        try {
          tokens = await build();
          const a = await owner();
          const t = await pat(a, { roles: ['admin'] });
          expect((await row(t.record.id)).Roles).to.deep.equal(['admin']);
        } finally {
          DI.unregister(RoleSource);
        }
      });
    });
  });

  describe('a TTL cap the schema never saw', () => {
    it('refuses every expiry when the cap is not finite', async () => {
      const a = await owner();
      setTokenPastSchema('maxTtlDays', Infinity);
      await refused(a, { name: 'x', kind: 'pat', expiresAt: at(DAY) }, 'invalid_expiry');
      setToken('maxTtlDays', 90);
      setTokenPastSchema('agentMaxTtlMinutes', Infinity);
      await refused(a, { name: 'x', kind: 'agent', scope: { agent: true }, expiresAt: at(60 * MINUTE) }, 'invalid_expiry');
      // The restore in afterEach goes through set(), which refuses to start from a value past the schema.
      setToken('agentMaxTtlMinutes', savedConfig.get('agentMaxTtlMinutes'));
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

    it('create throws InvalidOperation and stores nothing', async () => {
      const a = await owner();
      for (const [label, now] of bad) {
        const before = await count();
        const err = await create(a, { name: 'x', kind: 'pat', expiresAt: at(DAY) }, badCtx(now)).catch((e: unknown) => e);
        expect(err, label).to.be.instanceOf(InvalidOperation);
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
        await identityChanged(a);
        expect(await validate(t.plaintext)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
        expect(await validate(g.plaintext)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });

        identities.setStatus(a, { active: true, banned: false, deleted: false });
        await identityChanged(a);
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
      await identityChanged(a);
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

  describe('rotate', () => {
    const ok = async (o: IdentityRef, id: string, c: AuthnContext = ctx(), opts?: { graceSeconds?: number }) => {
      const r = await tokens.rotate(o, id, c, opts);
      if (!r.ok) {
        throw new Error(`not rotated: ${JSON.stringify(r)}`);
      }
      return r;
    };

    it('stores the hash of the new secret, and with a grace the hash of the old one until the grace ends', async () => {
      const a = await owner();
      const t = await pat(a);
      const r = await ok(a, t.record.id, ctx(at(MINUTE)), { graceSeconds: 60 });

      const stored = await row(t.record.id);
      expect(stored.Token).to.equal(sha256(r.plaintext));
      expect(stored.PreviousToken).to.equal(sha256(t.plaintext));
      expect(stored.PreviousValidUntil?.toMillis()).to.equal(at(2 * MINUTE).getTime());

      const json = JSON.stringify(await v3Connection().select().from(TABLE));
      expect(json).to.not.contain(t.plaintext);
      expect(json).to.not.contain(r.plaintext);
    });

    it('without a grace it keeps no previous hash, and drops one a former rotation kept', async () => {
      const a = await owner();
      const t = await pat(a);

      await ok(a, t.record.id, ctx(), { graceSeconds: 60 });
      expect((await row(t.record.id)).PreviousToken).to.be.a('string');

      const last = await ok(a, t.record.id);
      const stored = await row(t.record.id);
      expect(stored.Token).to.equal(sha256(last.plaintext));
      expect(stored.PreviousToken ?? null).to.equal(null);
      expect(stored.PreviousValidUntil ?? null).to.equal(null);
    });

    it('keeps the id, owner, name, kind, roles, profile, scope, expiry and creation time of the row', async () => {
      const a = await owner();
      profiles.allowed = ['viewer'];
      const t = await pat(a, { name: 'ci', roles: ['viewer'], profile: 'viewer', scope: { permissions: ['conf:read'], resources: [{ type: 'project', id: 'p1' }] } });
      const before = await row(t.record.id);

      const r = await ok(a, t.record.id, ctx(at(HOUR)));
      const after = await row(t.record.id);
      for (const column of ['Id', 'Uuid', 'Name', 'Kind', 'Profile', 'user_id'] as const) {
        expect(after[column], column).to.deep.equal(before[column]);
      }
      expect(after.Roles).to.deep.equal(before.Roles);
      expect(after.Scope).to.deep.equal(before.Scope);
      expect(after.ExpiresAt?.toMillis()).to.equal(before.ExpiresAt?.toMillis());
      expect(after.CreatedAt.toMillis()).to.equal(before.CreatedAt.toMillis());
      expect(r.token).to.deep.equal((await tokens.list(a))[0]);
    });

    it('throws InvalidArgument for a grace that is not a whole number of seconds from 0 to 604800, and rotates nothing', async () => {
      const a = await owner();
      const t = await pat(a);
      for (const graceSeconds of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 604_801, '60', null, {}]) {
        const err = await tokens.rotate(a, t.record.id, ctx(), { graceSeconds: graceSeconds as number }).catch((e: unknown) => e);
        expect(err, `graceSeconds ${JSON.stringify(graceSeconds)}`).to.be.instanceOf(InvalidArgument);
      }
      expect((await row(t.record.id)).Token).to.equal(sha256(t.plaintext));
      expect((await tokens.rotate(a, t.record.id, ctx(), { graceSeconds: 604_800 })).ok).to.equal(true);
    });

    it('answers not_found for another owner, an unknown or non-string id, an owner without a row, a revoked and an expired token', async () => {
      const a = await owner();
      const b = await owner();
      const t = await pat(a);
      const gone = await pat(a);
      const short = await pat(a, { expiresAt: at(MINUTE) });
      expect(await tokens.revoke(a, gone.record.id, ctx())).to.equal(true);

      const notFound = { ok: false, reason: 'not_found' };
      expect({ ...(await tokens.rotate(b, t.record.id, ctx())) }, 'another owner').to.deep.equal(notFound);
      expect({ ...(await tokens.rotate(a, randomUUID(), ctx())) }, 'unknown id').to.deep.equal(notFound);
      expect({ ...(await tokens.rotate(a, 7 as unknown as string, ctx())) }, 'non-string id').to.deep.equal(notFound);
      expect({ ...(await tokens.rotate({ type: 'user', id: randomUUID() }, t.record.id, ctx())) }, 'unknown owner').to.deep.equal(notFound);
      expect({ ...(await tokens.rotate(a, gone.record.id, ctx())) }, 'revoked').to.deep.equal(notFound);
      expect({ ...(await tokens.rotate(a, short.record.id, ctx(at(MINUTE)))) }, 'expired at once').to.deep.equal(notFound);
      expect((await row(t.record.id)).Token).to.equal(sha256(t.plaintext));
    });

    it('throws InvalidOperation for an invalid ctx.now and leaves the token as it was', async () => {
      const a = await owner();
      const t = await pat(a);
      const err = await tokens.rotate(a, t.record.id, { now: new Date(Number.NaN), purpose: 'request' }).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(InvalidOperation);
      expect((await row(t.record.id)).Token).to.equal(sha256(t.plaintext));
    });

    it('of two rotations racing for one token only one wins, and its plaintext is the token', async () => {
      const a = await owner();
      const t = await pat(a);
      const answers = await Promise.all([tokens.rotate(a, t.record.id, ctx()), tokens.rotate(a, t.record.id, ctx())]);

      const won = answers.filter((r) => r.ok);
      expect(won).to.have.length(1);
      expect(answers.filter((r) => !r.ok).map((r) => ({ ...r }))).to.deep.equal([{ ok: false, reason: 'not_found' }]);
      const [winner] = won as Array<{ plaintext: string }>;
      expect((await validate(winner.plaintext)).ok).to.equal(true);
      expect(await validate(t.plaintext)).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
    });

    it('a secret in grace stops at PreviousValidUntil, and the token expiry still ends it', async () => {
      const a = await owner();
      const t = await pat(a, { expiresAt: at(2 * MINUTE) });
      await ok(a, t.record.id, ctx(), { graceSeconds: 3600 });

      expect((await validate(t.plaintext, ctx(at(MINUTE)))).ok).to.equal(true);
      expect(await validate(t.plaintext, ctx(at(2 * MINUTE)))).to.deep.equal({ ok: false, reason: 'expired' });
    });

    it('does not let a stored previous hash outlive its PreviousValidUntil, whatever the clock of the row', async () => {
      const a = await owner();
      const t = await pat(a);
      await ok(a, t.record.id, ctx(), { graceSeconds: 60 });

      expect(await validate(t.plaintext, ctx(at(60 * SECOND)))).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
      await AccessToken.update({ PreviousValidUntil: null } as never).where('Uuid', t.record.id);
      expect(await validate(t.plaintext, ctx(at(SECOND)))).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
    });
  });

  describe('update', () => {
    const ok = async (o: IdentityRef, id: string, change: Parameters<DbTokenService['update']>[2], c: AuthnContext = ctx()) => {
      const r = await tokens.update(o, id, change, c);
      if (!r.ok) {
        throw new Error(`not updated: ${JSON.stringify(r)}`);
      }
      return r;
    };
    const refusedWith = async (o: IdentityRef, id: string, change: Record<string, unknown>, reason: string, label: string) => {
      expect({ ...(await tokens.update(o, id, change, ctx())) }, label).to.deep.equal({ ok: false, reason });
    };

    it('writes the name, the narrowed roles and the earlier expiry, and nothing else', async () => {
      const a = await owner();
      const t = await pat(a, { roles: ['editor', 'viewer'], scope: { permissions: ['conf:read'] } });
      const before = await row(t.record.id);

      const r = await ok(a, t.record.id, { name: '  renamed  ', roles: ['viewer', 'viewer'], expiresAt: at(HOUR) });
      expect(r.token).to.deep.equal({ ...t.record, name: 'renamed', roles: ['viewer'], expiresAt: at(HOUR) });

      const after = await row(t.record.id);
      expect(after.Name).to.equal('renamed');
      expect(after.Roles).to.deep.equal(['viewer']);
      expect(after.ExpiresAt?.toMillis()).to.equal(at(HOUR).getTime());
      for (const column of ['Id', 'Uuid', 'Token', 'Kind', 'user_id', 'PreviousToken'] as const) {
        expect(after[column] ?? null, column).to.deep.equal(before[column] ?? null);
      }
      expect(after.Scope).to.deep.equal(before.Scope);
      expect((await validate(t.plaintext)).ok).to.equal(true);
    });

    it('updates an agent token name and expiry, and refuses roles on it', async () => {
      const a = await owner();
      const g = await agent(a);
      expect((await ok(a, g.record.id, { name: 'renamed', expiresAt: at(30 * MINUTE) })).token.expiresAt).to.deep.equal(at(30 * MINUTE));
      await refusedWith(a, g.record.id, { roles: ['viewer'] }, 'invalid_scope', 'agent roles');
    });

    it('refuses a role the token lacks, an empty or malformed list and a comma, and stores nothing', async () => {
      const a = await owner();
      const t = await pat(a, { roles: ['editor', 'viewer'] });
      for (const [label, roles] of [
        ['an added role', ['viewer', 'admin']],
        ['another role', ['admin']],
        ['empty', []],
        ['not a list', 'viewer'],
        ['a number', [7]],
        ['a comma', ['viewer,editor']],
        ['blank', ['']],
      ] as const) {
        await refusedWith(a, t.record.id, { name: 'renamed', roles }, 'invalid_scope', label);
      }
      const stored = await row(t.record.id);
      expect(stored.Roles).to.deep.equal(['editor', 'viewer']);
      expect(stored.Name).to.equal('pat');
    });

    it('refuses an expiry that is later than the stored one, not after ctx.now or not a date, and stores nothing', async () => {
      const a = await owner();
      const t = await pat(a);
      for (const [label, expiresAt] of [
        ['one millisecond later', new Date(t.record.expiresAt.getTime() + 1)],
        ['now', NOW],
        ['the past', at(-MINUTE)],
        ['invalid date', new Date(Number.NaN)],
        ['a string', at(HOUR).toISOString()],
        ['null', null],
      ] as const) {
        await refusedWith(a, t.record.id, { name: 'renamed', expiresAt }, 'invalid_expiry', label);
      }
      const stored = await row(t.record.id);
      expect(stored.ExpiresAt?.toMillis()).to.equal(t.record.expiresAt.getTime());
      expect(stored.Name).to.equal('pat');

      await ok(a, t.record.id, { expiresAt: t.record.expiresAt });
    });

    it('throws InvalidArgument for a blank, over-long or non-string name, and stores nothing', async () => {
      const a = await owner();
      const t = await pat(a);
      for (const name of ['', '   ', 'n'.repeat(129), 7, null]) {
        const err = await tokens.update(a, t.record.id, { name } as never, ctx()).catch((e: unknown) => e);
        expect(err, `name ${JSON.stringify(name)}`).to.be.instanceOf(InvalidArgument);
      }
      expect((await row(t.record.id)).Name).to.equal('pat');
      expect((await ok(a, t.record.id, { name: 'n'.repeat(128) })).token.name).to.have.length(128);
    });

    it('is owner-bound: another owner, an unknown id, an owner without a row and a revoked token are not_found', async () => {
      const a = await owner();
      const b = await owner();
      const t = await pat(a);
      const gone = await pat(a);
      expect(await tokens.revoke(a, gone.record.id, ctx())).to.equal(true);

      await refusedWith(b, t.record.id, { name: 'taken' }, 'not_found', 'another owner');
      await refusedWith(a, randomUUID(), { name: 'x' }, 'not_found', 'unknown id');
      await refusedWith({ type: 'user', id: randomUUID() }, t.record.id, { name: 'x' }, 'not_found', 'unknown owner');
      await refusedWith(a, gone.record.id, { name: 'x' }, 'not_found', 'revoked');
      expect((await row(t.record.id)).Name).to.equal('pat');
    });

    it('with nothing to change answers the token and writes nothing', async () => {
      const a = await owner();
      const t = await pat(a);
      sink.clear();
      const r = await ok(a, t.record.id, {});
      expect(r.token).to.deep.equal(t.record);
      expect(sink.all()).to.deep.equal([]);
    });

    it('ignores keys it does not know, so a body cannot reach the kind, the profile or the scope', async () => {
      const a = await owner();
      const t = await pat(a);
      await ok(a, t.record.id, { kind: 'agent', profile: 'admin', scope: { agent: true }, Token: 'x', user_id: 99 } as never);
      const stored = await row(t.record.id);
      expect(stored.Kind).to.equal('pat');
      expect(stored.Profile ?? null).to.equal(null);
      expect(stored.Token).to.equal(sha256(t.plaintext));
    });

    describe('roles of a token without roles', () => {
      let scope: IContainer | undefined;

      beforeEach(async () => {
        DI.register(ViewerRoleSource).as(RoleSource);
        scope = DI.child();
        scope.register(() => profiles).as(TokenProfilePolicy);
        scope.register(() => identities).as(IdentityStore);
        scope.register(DbTokenService).asSelf();
        tokens = await scope.resolve(DbTokenService);
      });

      afterEach(async () => {
        await scope?.dispose();
        scope = undefined;
        DI.unregister(ViewerRoleSource);
        DI.uncache(ViewerRoleSource);
        DI.uncache(RoleSource);
        ViewerRoleSource.asked.length = 0;
      });

      it('may be pinned to roles the owner holds, never to others', async () => {
        const a = await owner();
        const t = await pat(a);
        await refusedWith(a, t.record.id, { roles: ['admin'] }, 'invalid_scope', 'a role the owner lacks');
        await refusedWith(a, t.record.id, { roles: ['viewer', 'admin'] }, 'invalid_scope', 'one the owner lacks among others');
        expect((await ok(a, t.record.id, { roles: ['viewer'] })).token.roles).to.deep.equal(['viewer']);
        expect((await row(t.record.id)).Roles).to.deep.equal(['viewer']);
      });

      it('asks the RoleSource nothing for a token that already has roles', async () => {
        const a = await owner();
        const t = await pat(a, { roles: ['viewer'] });
        ViewerRoleSource.asked.length = 0;
        await refusedWith(a, t.record.id, { roles: ['admin'] }, 'invalid_scope', 'not a subset');
        await ok(a, t.record.id, { roles: ['viewer'] });
        expect(ViewerRoleSource.asked).to.deep.equal([]);
      });
    });
  });

  describe('rotate and update events', () => {
    it('publishes token.rotate and token.update without the plaintext or a hash', async () => {
      const a = await owner();
      const t = await pat(a, { roles: ['editor', 'viewer'] });
      sink.clear();

      const r = await tokens.rotate(a, t.record.id, ctx(at(MINUTE), { ip: '192.0.2.9' }), { graceSeconds: 30 });
      expect(r.ok).to.equal(true);
      expect((await tokens.update(a, t.record.id, { name: 'renamed', roles: ['viewer'], expiresAt: at(HOUR) }, ctx(at(2 * MINUTE)))).ok).to.equal(true);
      expect((await tokens.rotate(a, t.record.id, ctx(at(3 * MINUTE)))).ok).to.equal(true);

      expect(sink.all()).to.deep.equal([
        { type: 'token.rotate', at: at(MINUTE), outcome: 'success', identity: a, ip: '192.0.2.9', data: { token: t.record.id, kind: 'pat', graceSeconds: 30 } },
        { type: 'token.update', at: at(2 * MINUTE), outcome: 'success', identity: a, data: { token: t.record.id, kind: 'pat', fields: ['name', 'roles', 'expiresAt'] } },
        { type: 'token.rotate', at: at(3 * MINUTE), outcome: 'success', identity: a, data: { token: t.record.id, kind: 'pat', graceSeconds: 0 } },
      ]);

      const json = JSON.stringify(sink.all());
      for (const secret of [t.plaintext, sha256(t.plaintext), (r as { plaintext: string }).plaintext, sha256((r as { plaintext: string }).plaintext)]) {
        expect(json).to.not.contain(secret);
      }
    });

    it('publishes nothing for a refused rotation or update', async () => {
      const a = await owner();
      const b = await owner();
      const t = await pat(a, { roles: ['viewer'] });
      sink.clear();

      await tokens.rotate(b, t.record.id, ctx());
      await tokens.rotate(a, randomUUID(), ctx());
      await tokens.rotate(a, t.record.id, ctx(), { graceSeconds: -1 }).catch(() => undefined);
      await tokens.update(b, t.record.id, { name: 'x' }, ctx());
      await tokens.update(a, t.record.id, { roles: ['admin'] }, ctx());
      await tokens.update(a, t.record.id, { expiresAt: at(2 * DAY) }, ctx());
      expect(sink.all()).to.deep.equal([]);
    });

    it('keeps a completed rotation when a sink throws', async () => {
      tokens = await build({ auditor: AuthnAudit.over([new ThrowingTokenSink()]) });
      const a = await owner();
      const t = await pat(a);
      const r = await tokens.rotate(a, t.record.id, ctx());
      expect(r.ok).to.equal(true);
      expect((await validate((r as { plaintext: string }).plaintext)).ok).to.equal(true);
    });
  });

  describe('revokeByPlaintext events', () => {
    it('publishes token.revoke with reason self for the owner, without the plaintext or its hash', async () => {
      const a = await owner();
      const t = await pat(a);
      const g = await agent(a);
      const next = await tokens.rotate(a, t.record.id, ctx(at(MINUTE)), { graceSeconds: 300 });
      if (!next.ok) {
        throw new Error('not rotated');
      }
      sink.clear();

      expect(await tokens.revokeByPlaintext(g.plaintext, ctx(at(2 * MINUTE), { ip: '192.0.2.9' }))).to.equal(true);
      expect(await tokens.revokeByPlaintext(t.plaintext, ctx(at(3 * MINUTE)))).to.equal(true);

      expect(sink.all()).to.deep.equal([
        { type: 'token.revoke', at: at(2 * MINUTE), outcome: 'success', reason: 'self', identity: a, ip: '192.0.2.9', data: { token: g.record.id, kind: 'agent' } },
        { type: 'token.revoke', at: at(3 * MINUTE), outcome: 'success', reason: 'self', identity: a, data: { token: t.record.id, kind: 'pat' } },
      ]);

      const json = JSON.stringify(sink.all());
      for (const secret of [t.plaintext, sha256(t.plaintext), g.plaintext, sha256(g.plaintext), next.plaintext, sha256(next.plaintext)]) {
        expect(json).to.not.contain(secret);
      }
    });

    it('publishes nothing for an unknown, malformed, already revoked or out-of-grace plaintext', async () => {
      const a = await owner();
      const t = await pat(a);
      const old = await pat(a);
      expect((await tokens.rotate(a, old.record.id, ctx(), { graceSeconds: 30 })).ok).to.equal(true);
      const gone = await pat(a);
      expect(await tokens.revoke(a, gone.record.id, ctx())).to.equal(true);
      sink.clear();

      for (const raw of ['spt_unknown', '', gone.plaintext, t.plaintext + 'x']) {
        expect(await tokens.revokeByPlaintext(raw, ctx()), raw).to.equal(false);
      }
      expect(await tokens.revokeByPlaintext(old.plaintext, ctx(at(30 * SECOND)))).to.equal(false);
      expect(sink.all()).to.deep.equal([]);
    });

    it('keeps a completed revocation when a sink throws', async () => {
      tokens = await build({ auditor: AuthnAudit.over([new ThrowingTokenSink()]) });
      const a = await owner();
      const t = await pat(a);
      expect(await tokens.revokeByPlaintext(t.plaintext, ctx())).to.equal(true);
      expect(await validate(t.plaintext)).to.deep.equal({ ok: false, reason: 'revoked' });
    });

    it('revokes the token of an owner who is banned since', async () => {
      const banned = await owner();
      const t = await pat(banned);
      identities.setStatus(banned, { banned: true });
      expect(await tokens.revokeByPlaintext(t.plaintext, ctx())).to.equal(true);
      expect((await row(t.record.id)).RevokedAt?.toMillis()).to.equal(NOW.getTime());
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

    it('works with no sink', async () => {
      tokens = await build({ auditor: AuthnAudit.over([]) });
      const a = await owner();
      const t = await pat(a);
      expect(await tokens.revoke(a, t.record.id, ctx())).to.equal(true);
    });

    it('keeps a stored token and a completed revoke when a sink throws', async () => {
      tokens = await build({ auditor: AuthnAudit.over([new ThrowingTokenSink(), sink]) });
      const a = await owner();

      const t = await pat(a);
      expect(t.plaintext).to.match(/^spt_/);
      expect((await validate(t.plaintext)).ok).to.equal(true);

      expect(await tokens.revoke(a, t.record.id, ctx())).to.equal(true);
      expect(await validate(t.plaintext)).to.deep.equal({ ok: false, reason: 'revoked' });

      await pat(a);
      expect(await tokens.revokeAllFor(a, ctx())).to.equal(1);

      expect(sink.all().map((e) => e.type)).to.deep.equal(['token.create', 'token.revoke', 'token.create', 'token.revoke']);
    });

    it('holds a create or a revoke no longer than the audit timeout when a sink hangs', async () => {
      tokens = await build({ auditor: AuthnAudit.over([new HangingTokenSink(), sink], { sinkTimeoutMs: 50 }) });
      const a = await owner();
      const started = Date.now();

      const t = await pat(a);
      expect(t.plaintext).to.match(/^spt_/);
      expect(await tokens.revoke(a, t.record.id, ctx())).to.equal(true);

      expect(Date.now() - started).to.be.below(2000);
      expect(sink.all().map((e) => e.type)).to.deep.equal(['token.create', 'token.revoke']);
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

    it('refuses to start when DI has no IdentityStore to inject', async () => {
      // @spinajs/users registers an IdentityStore once any suite imports it; hidden here for the test.
      const registered = [...(DI.getRegisteredTypes(IdentityStore) ?? [])];
      registered.forEach((type) => DI.unregister(type));
      const child = DI.child();
      child.register(DbTokenService).as(TokenService);
      try {
        const err = await Promise.resolve()
          .then(() => child.resolve(TokenService))
          .catch((e: unknown) => e);
        expect(err).to.be.instanceOf(Error);
        expect((err as Error).message).to.match(/IdentityStore/);
      } finally {
        await child.dispose();
        registered.forEach((type) => DI.register(type).as(IdentityStore));
      }
    });

    it('publishes through the AuthnAudit of its container', async () => {
      DI.register(TokenTestIdentityStore).as(IdentityStore);
      const service = await DI.resolve(TokenService);
      expect((service as unknown as { Audit: unknown }).Audit).to.equal(await DI.resolve(AuthnAudit));
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

    // The schema refuses these at boot; a Configuration.set it never saw must still fail closed.
    it('refuses every expiry while a ttl cap set at run time is not a positive number', async () => {
      const a = await owner();
      for (const [key, value] of [
        ['maxTtlDays', 0],
        ['maxTtlDays', 'ninety'],
        ['agentMaxTtlMinutes', -1],
        ['agentMaxTtlMinutes', 'sixty'],
      ] as const) {
        setTokenPastSchema(key, value);
        const agentKind = key === 'agentMaxTtlMinutes';
        await refused(a, { name: 'x', kind: agentKind ? 'agent' : 'pat', ...(agentKind ? { scope: { agent: true } } : {}), expiresAt: at(MINUTE) }, 'invalid_expiry', `${key} = ${value}`);
        setToken(key, savedConfig.get(key));
      }
    });
  });
});
