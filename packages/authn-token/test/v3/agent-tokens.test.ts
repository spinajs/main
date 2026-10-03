import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { AuthnContext, IdentityRef, TokenCreateOptions, TokenCreateResult, TokenValidation } from '@spinajs/authn/contracts';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, MemoryLinkStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, throttleParams } from '@spinajs/authn-testing';

import '../../src/generator.js';
import { DbTokenService, TokenProfilePolicy, UsersTableTokenOwnerResolver } from '../../src/service/index.js';
import { TokenStrategy } from '../../src/strategy/TokenStrategy.js';
import { bootV3Db, insertUserRow, shutdownV3Db, v3Connection } from './db.js';

const TABLE = 'rbac_access_tokens';
const NOW = new Date('2026-10-03T10:00:00.000Z');
const MINUTE = 60_000;
const DAY = 1440 * MINUTE;

const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const ctx = (now: Date = NOW, over: Partial<AuthnContext> = {}): AuthnContext => ({ now, purpose: 'request', ...over });

type Ok = Extract<TokenCreateResult, { ok: true }>;
type Valid = Extract<TokenValidation, { ok: true }>;

class AgentTestProfilePolicy extends TokenProfilePolicy {
  public allowed: string[] = [];

  public async allowedProfiles(_owner: IdentityRef): Promise<readonly string[]> {
    return [...this.allowed];
  }
}

describe('agent tokens (A15)', function () {
  this.timeout(15000);

  let identities: FakeIdentityStore;
  let profiles: AgentTestProfilePolicy;
  let tokens: DbTokenService;
  let strategy: TokenStrategy;
  const savedConfig = new Map<string, unknown>();

  const config = () => DI.get(Configuration)!;
  const setToken = (key: string, value: unknown) => config().set(['authn', 'token', key], value);

  before(async () => {
    await bootV3Db();
    for (const key of ['maxTtlDays', 'agentMaxTtlMinutes']) {
      savedConfig.set(key, config().get(['authn', 'token', key]));
    }
  });

  after(async () => {
    await shutdownV3Db();
  });

  beforeEach(async () => {
    identities = new FakeIdentityStore();
    profiles = new AgentTestProfilePolicy();
    tokens = new DbTokenService(new UsersTableTokenOwnerResolver(), profiles, identities);
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

  function create(o: IdentityRef, opts: Record<string, unknown>): Promise<TokenCreateResult> {
    return tokens.create(o, opts as unknown as TokenCreateOptions, ctx());
  }

  async function mint(o: IdentityRef, opts: Record<string, unknown>): Promise<Ok> {
    const r = await create(o, opts);
    if (!r.ok) {
      throw new Error(`not minted: ${JSON.stringify(r)}`);
    }
    return r;
  }

  const agent = (o: IdentityRef, scope: Record<string, unknown> = {}, expiresAt: Date = at(60 * MINUTE)): Promise<Ok> => mint(o, { name: 'agent', kind: 'agent', scope: { agent: true, ...scope }, expiresAt });

  const pat = (o: IdentityRef, over: Record<string, unknown> = {}): Promise<Ok> => mint(o, { name: 'pat', kind: 'pat', expiresAt: at(DAY), ...over });

  async function valid(plaintext: string, c: AuthnContext = ctx()): Promise<Valid> {
    const v = await tokens.validate(plaintext, c);
    if (!v.ok) {
      throw new Error(`not valid: ${JSON.stringify(v)}`);
    }
    return v;
  }

  /** Hand-edits a stored row, as an operator with database access could. */
  async function edit(id: string, values: Record<string, unknown>): Promise<void> {
    await v3Connection().update().in(TABLE).update(values).where({ Uuid: id });
  }

  async function failsClosed(plaintext: string, label: string): Promise<void> {
    expect(await tokens.validate(plaintext, ctx()), label).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
    expect(await strategy.verify({ kind: 'bearer', token: plaintext }, ctx()), label).to.deep.equal({ ok: false, reason: 'invalid_credentials' });
  }

  describe('a stored row must agree with its kind', () => {
    it('fails closed on an agent row whose Scope lacks agent: true', async () => {
      const a = await owner();
      for (const [label, scope] of [
        ['agent key missing', JSON.stringify({ permissions: ['file:read'] })],
        ['agent: false', JSON.stringify({ agent: false })],
        ['agent: "true"', JSON.stringify({ agent: 'true' })],
        ['agent: 1', JSON.stringify({ agent: 1 })],
        ['no Scope', null],
      ] as const) {
        const g = await agent(a, { permissions: ['file:read'] });
        await edit(g.record.id, { Scope: scope });
        await failsClosed(g.plaintext, label);
      }
    });

    it('fails closed on a pat or service row whose Scope says agent', async () => {
      const a = await owner();
      for (const kind of ['pat', 'service']) {
        for (const agentValue of [true, 'true', 1]) {
          const t = await pat(a, { kind, scope: { permissions: ['file:read'] } });
          await edit(t.record.id, { Scope: JSON.stringify({ agent: agentValue, permissions: ['file:read'] }) });
          await failsClosed(t.plaintext, `${kind} with agent ${JSON.stringify(agentValue)}`);
        }
      }
    });

    it('fails closed on an agent row carrying Roles or a Profile', async () => {
      const a = await owner();
      profiles.allowed = ['editor'];

      const withRoles = await agent(a);
      await edit(withRoles.record.id, { Roles: 'admin' });
      await failsClosed(withRoles.plaintext, 'Roles');

      const withProfile = await agent(a);
      await edit(withProfile.record.id, { Profile: 'editor' });
      await failsClosed(withProfile.plaintext, 'Profile');
    });

    it('fails closed on a Scope that is not a well-formed TokenScope, whatever the kind', async () => {
      const a = await owner();
      for (const [label, scope] of [
        ['permissions as a string', { permissions: 'file:read' }],
        ['an empty permission', { permissions: [''] }],
        ['a resource without type', { resources: [{ id: '7' }] }],
        ['resources as an object', { resources: { type: 'file' } }],
        ['a misspelt key', { permission: ['file:read'] }],
        ['a roles key', { roles: ['viewer'] }],
        ['a resource with an extra key', { resources: [{ type: 'file', id: '7', under: 'p1' }] }],
      ] as const) {
        const g = await agent(a, { permissions: ['file:read'] });
        await edit(g.record.id, { Scope: JSON.stringify({ agent: true, ...scope }) });
        await failsClosed(g.plaintext, `agent, ${label}`);

        const t = await pat(a, { scope: { permissions: ['file:read'] } });
        await edit(t.record.id, { Scope: JSON.stringify(scope) });
        await failsClosed(t.plaintext, `pat, ${label}`);
      }
      for (const scope of ['"file:read"', '[]', '7']) {
        const t = await pat(a, { scope: { permissions: ['file:read'] } });
        await edit(t.record.id, { Scope: scope });
        await failsClosed(t.plaintext, `pat, Scope ${scope}`);
      }
    });

    it('still validates pat and service rows with a stored {} or {"agent":false} scope, without a ceiling', async () => {
      const a = await owner();
      for (const kind of ['pat', 'service']) {
        for (const scope of ['{}', '{"agent":false}']) {
          const t = await pat(a, { kind });
          await edit(t.record.id, { Scope: scope });
          const v = await valid(t.plaintext);
          expect(v.ceiling, `${kind} ${scope}`).to.equal(undefined);
          expect((await tokens.list(a)).find((r) => r.id === t.record.id)?.kind).to.equal(kind);
        }
      }
    });
  });

  describe('validation', () => {
    it('yields the agent identity, the delegation to the owner and no roles or profile', async () => {
      const a = await owner();
      const g = await agent(a, { permissions: ['file:read'] });

      const v = await valid(g.plaintext);
      expect(Object.keys(v).sort()).to.deep.equal(['ceiling', 'delegation', 'identity', 'method', 'ok', 'token']);
      expect(v.identity).to.deep.equal({ type: 'agent', id: g.record.id });
      expect(v.method).to.equal('token');
      expect(v.delegation).to.deep.equal({ onBehalfOf: a, mode: 'inherit' });
      expect(v.ceiling).to.deep.equal({ permissions: ['file:read'], reason: 'out_of_scope' });
      expect(v.token).to.deep.equal(g.record);
    });

    it('copies the stored permissions and resources exactly: [] stays [], absent stays absent', async () => {
      const a = await owner();
      const file = { type: 'file', id: '7' };
      for (const [scope, ceiling] of [
        [{}, { reason: 'out_of_scope' }],
        [{ permissions: [] }, { permissions: [], reason: 'out_of_scope' }],
        [{ resources: [] }, { resources: [], reason: 'out_of_scope' }],
        [
          { permissions: [], resources: [] },
          { permissions: [], resources: [], reason: 'out_of_scope' },
        ],
        [{ permissions: ['file:*', 'project:read'] }, { permissions: ['file:*', 'project:read'], reason: 'out_of_scope' }],
        [{ resources: [file, { type: 'dir' }] }, { resources: [file, { type: 'dir' }], reason: 'out_of_scope' }],
      ] as const) {
        const g = await agent(a, scope);
        expect((await valid(g.plaintext)).ceiling, JSON.stringify(scope)).to.deep.equal(ceiling);
      }
    });

    it('answers invalid_credentials for a banned, inactive or deleted owner, on every use', async () => {
      const a = await owner();
      const g = await agent(a);
      for (const status of [{ banned: true }, { active: false }, { deleted: true }]) {
        identities.setStatus(a, status);
        await failsClosed(g.plaintext, JSON.stringify(status));
        identities.setStatus(a, { active: true, banned: false, deleted: false });
        expect((await valid(g.plaintext)).identity).to.deep.equal({ type: 'agent', id: g.record.id });
      }
    });

    it('asks the identity store about the owner, never about the agent', async () => {
      const a = await owner();
      const g = await agent(a);
      identities.calls.status.length = 0;
      await valid(g.plaintext);
      expect(identities.calls.status).to.deep.equal([a]);
    });

    it('answers expired at the expiry', async () => {
      const a = await owner();
      const g = await agent(a, {}, at(30 * MINUTE));
      await valid(g.plaintext, ctx(at(30 * MINUTE - 1)));
      expect(await tokens.validate(g.plaintext, ctx(at(30 * MINUTE)))).to.deep.equal({ ok: false, reason: 'expired' });
    });
  });

  describe('revocation', () => {
    it('lets the owner revoke an agent token, and nobody else', async () => {
      const a = await owner();
      const b = await owner();
      const g = await agent(a);

      expect(await tokens.revoke(b, g.record.id, ctx())).to.equal(false);
      await valid(g.plaintext);

      expect(await tokens.revoke(a, g.record.id, ctx())).to.equal(true);
      expect(await tokens.validate(g.plaintext, ctx())).to.deep.equal({ ok: false, reason: 'revoked' });
      expect(await strategy.verify({ kind: 'bearer', token: g.plaintext }, ctx())).to.deep.equal({ ok: false, reason: 'revoked' });
    });

    it('revokeAllFor(owner) ends the agent tokens acting for that owner only', async () => {
      const a = await owner();
      const b = await owner();
      const g1 = await agent(a);
      const g2 = await agent(a, { permissions: [] });
      const other = await agent(b);

      expect(await tokens.revokeAllFor(a, ctx())).to.equal(2);
      for (const g of [g1, g2]) {
        expect(await tokens.validate(g.plaintext, ctx())).to.deep.equal({ ok: false, reason: 'revoked' });
      }
      await valid(other.plaintext);
    });
  });

  describe('lifetime', () => {
    it('accepts exactly a configured agentMaxTtlMinutes and refuses 1 ms more', async () => {
      const a = await owner();
      setToken('agentMaxTtlMinutes', 30);
      await agent(a, {}, at(30 * MINUTE));
      expect(await create(a, { name: 'x', kind: 'agent', scope: { agent: true }, expiresAt: at(30 * MINUTE + 1) })).to.deep.equal({ ok: false, code: 'invalid_expiry' });
    });

    it('never lets an agent token outlive the PAT cap', async () => {
      const a = await owner();
      setToken('maxTtlDays', 1);
      setToken('agentMaxTtlMinutes', 3 * 1440);
      await agent(a, {}, at(DAY));
      expect(await create(a, { name: 'x', kind: 'agent', scope: { agent: true }, expiresAt: at(DAY + 1) })).to.deep.equal({ ok: false, code: 'invalid_expiry' });
      expect(await create(a, { name: 'x', kind: 'agent', scope: { agent: true }, expiresAt: at(3 * DAY) })).to.deep.equal({ ok: false, code: 'invalid_expiry' });
    });
  });

  describe('TokenStrategy', () => {
    it('answers ok, the agent identity, method, ceiling and delegation, and no attributes', async () => {
      const a = await owner();
      const g = await agent(a, { permissions: ['file:read'], resources: [{ type: 'file', id: '7' }] });

      const outcome = await strategy.verify({ kind: 'bearer', token: g.plaintext }, ctx());
      expect(outcome).to.deep.equal({
        ok: true,
        identity: { type: 'agent', id: g.record.id },
        method: 'token',
        ceiling: { permissions: ['file:read'], resources: [{ type: 'file', id: '7' }], reason: 'out_of_scope' },
        delegation: { onBehalfOf: a, mode: 'inherit' },
      });
      expect(Object.keys(outcome).sort()).to.deep.equal(['ceiling', 'delegation', 'identity', 'method', 'ok']);
    });

    it('keeps an empty permission list in the outcome', async () => {
      const a = await owner();
      const g = await agent(a, { permissions: [] });
      const outcome = await strategy.verify({ kind: 'bearer', token: g.plaintext }, ctx());
      expect(outcome.ok && outcome.ceiling).to.deep.equal({ permissions: [], reason: 'out_of_scope' });
    });
  });

  describe('through FakeAuthnService', () => {
    // FakeAuthnService asks IdentityStore.status for the agent identity itself, so it refuses agents; N1's
    // DefaultAuthnService asks for delegation.onBehalfOf (N1 D4/D4b). Agent success is pinned on the strategy above.
    it('a PAT success carries the strategy ceiling and attributes', async () => {
      const a = await owner();
      profiles.allowed = ['editor'];
      const t = await pat(a, { roles: ['editor'], profile: 'editor', scope: { permissions: ['file:read'], resources: [] } });

      const service = new FakeAuthnService({
        strategies: [strategy],
        throttle: new FakeBackoffThrottle(throttleParams()),
        identities,
        links: new MemoryLinkStore(),
        linking: { jit: false, byVerifiedEmail: false },
        policy: new EnrolledMfaPolicy([]),
        steps: [],
        sessions: new MemorySessionIssuer(),
        sinks: [new RecordingEventSink()],
        principals: new RecordingPrincipalFactory(),
      });

      const outcome = await strategy.verify({ kind: 'bearer', token: t.plaintext }, ctx(at(MINUTE)));
      expect(outcome.ok).to.equal(true);
      const r = await service.authenticate({ kind: 'bearer', token: t.plaintext }, ctx(at(2 * MINUTE)));
      expect(r.status).to.equal('success');
      if (r.status !== 'success' || !outcome.ok) {
        return;
      }
      expect(r.identity).to.deep.equal(a);
      expect(r.ceiling).to.deep.equal({ roles: ['editor'], permissions: ['file:read'], resources: [] });
      expect(r.ceiling).to.deep.equal(outcome.ceiling);
      expect(r.attributes).to.deep.equal({ profile: 'editor' });
      expect(r.attributes).to.deep.equal(outcome.attributes);
      expect(r.delegation).to.equal(undefined);
    });
  });
});
