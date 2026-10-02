import * as chai from 'chai';
import 'mocha';
import { createHash, randomBytes } from 'node:crypto';

import { TokenService } from '../../src/contracts/token.js';
import type { TokenCreateOptions, TokenCreateResult, TokenKind, TokenRecord, TokenScope, TokenValidation } from '../../src/contracts/token.js';
import type { AuthnContext, AuthnFailure, IdentityRef, StrategyOutcome } from '../../src/contracts/credentials.js';
import type { Ceiling, PrincipalRef, ResourceRef } from '../../src/contracts/principal.js';
import * as index from '../../src/contracts/index.js';
import { classMembers, declarationDocs, docOf, memberDocs, same, shapeOf, unionLiterals } from './source-shape.js';

const expect = chai.expect;

const alice: IdentityRef = { type: 'user', id: 'alice' };
const bob: IdentityRef = { type: 'user', id: 'bob' };
const aliceService: IdentityRef = { type: 'service', id: 'alice' };
const ctx: AuthnContext = { now: new Date(1_000_000), ip: '10.0.0.1', purpose: 'request' };
const DAY = 86_400_000;

type Delegation = { readonly onBehalfOf: IdentityRef; readonly mode: 'inherit' };
type Valid = Extract<TokenValidation, { ok: true }>;

const sameOwner = (a: IdentityRef, b: IdentityRef) => a.type === b.type && a.id === b.id;

// Enough of a service to show the contract can be implemented as §22.9 describes it.
class MemoryTokens extends TokenService {
  private rows: { record: TokenRecord; hash: string; revoked: boolean }[] = [];
  readonly banned = new Set<string>();
  async create(owner: IdentityRef, opts: TokenCreateOptions, at: AuthnContext): Promise<TokenCreateResult> {
    const now = at.now.getTime();
    const max = opts.kind === 'agent' ? 1440 * 60_000 : 90 * DAY;
    if (opts.expiresAt.getTime() <= now || opts.expiresAt.getTime() - now > max) return { ok: false, code: 'invalid_expiry' };
    if ((opts.kind === 'agent') !== (opts.scope?.agent === true)) return { ok: false, code: 'invalid_scope' };
    if (opts.kind === 'agent' && (opts.roles !== undefined || opts.profile !== undefined)) return { ok: false, code: 'invalid_scope' };
    const plaintext = `spt_${randomBytes(32).toString('base64url')}`;
    const record: TokenRecord = { id: `t${this.rows.length + 1}`, owner, name: opts.name, kind: opts.kind, roles: opts.roles, profile: opts.profile, scope: opts.scope, createdAt: at.now, expiresAt: opts.expiresAt };
    this.rows.push({ record, hash: createHash('sha256').update(plaintext).digest('hex'), revoked: false });
    return { ok: true, plaintext, record };
  }
  async list(owner: IdentityRef): Promise<readonly TokenRecord[]> {
    return this.rows.filter((r) => !r.revoked && sameOwner(r.record.owner, owner)).map((r) => r.record);
  }
  async revoke(owner: IdentityRef, id: string, _ctx: AuthnContext, _opts?: { readonly actor?: PrincipalRef }): Promise<boolean> {
    const row = this.rows.find((r) => !r.revoked && r.record.id === id && sameOwner(r.record.owner, owner));
    if (row) row.revoked = true;
    return !!row;
  }
  async revokeAllFor(owner: IdentityRef, _ctx: AuthnContext, _opts?: { readonly actor?: PrincipalRef }): Promise<number> {
    const hit = this.rows.filter((r) => !r.revoked && sameOwner(r.record.owner, owner));
    for (const r of hit) r.revoked = true;
    return hit.length;
  }
  async validate(raw: string, at: AuthnContext): Promise<TokenValidation> {
    const row = this.rows.find((r) => r.hash === createHash('sha256').update(raw).digest('hex'));
    if (!row) return { ok: false, reason: 'invalid_credentials' };
    if (row.revoked) return { ok: false, reason: 'revoked' };
    if (row.record.expiresAt <= at.now) return { ok: false, reason: 'expired' };
    if (this.banned.has(row.record.owner.id)) return { ok: false, reason: 'invalid_credentials' };
    const { record } = row;
    const limits = { permissions: record.scope?.permissions, resources: record.scope?.resources };
    if (record.scope?.agent) {
      return { ok: true, identity: { type: 'agent', id: record.id }, method: 'token', ceiling: { ...limits, reason: 'out_of_scope' }, delegation: { onBehalfOf: record.owner, mode: 'inherit' }, token: record };
    }
    return { ok: true, identity: record.owner, method: 'token', ceiling: { roles: record.roles, ...limits }, profile: record.profile, token: record };
  }
}

const files: readonly ResourceRef[] = [{ type: 'project', id: 'p1' }];
const later = (ms: number) => new Date(ctx.now.getTime() + ms);

describe('token service contract', () => {
  describe('runtime', () => {
    it('exports TokenService from the contracts index as a plain abstract class', () => {
      expect(index.TokenService).to.eq(TokenService);
      expect(TokenService).to.be.a('function');
      expect(Object.getPrototypeOf(TokenService)).to.eq(Function.prototype);
    });

    it('create returns the plaintext once; list never shows it or its hash', async () => {
      const t = new MemoryTokens();
      const r = await t.create(alice, { name: 'ci', roles: ['dev'], profile: 'dev', kind: 'pat', expiresAt: later(DAY) }, ctx);
      if (!r.ok) throw new Error('create failed');
      expect(r.plaintext).to.match(/^spt_/);
      expect(r.record.profile).to.eq('dev');
      const [listed] = await t.list(alice);
      expect(listed).to.deep.eq(r.record);
      expect(JSON.stringify(listed)).to.not.contain(r.plaintext);
      for (const k of ['plaintext', 'hash', 'token']) expect(listed).to.not.have.property(k);
    });

    it('create refuses an expiry past the cap, a kind that disagrees with scope.agent and an agent token with roles', async () => {
      const t = new MemoryTokens();
      // Shapes the types refuse, as a JS caller could still send them.
      const raw = (o: object) => o as TokenCreateOptions;
      expect(await t.create(alice, { name: 'x', kind: 'pat', expiresAt: later(91 * DAY) }, ctx)).to.deep.eq({ ok: false, code: 'invalid_expiry' });
      expect(await t.create(alice, { name: 'x', kind: 'agent', scope: { agent: true }, expiresAt: later(DAY + 1) }, ctx)).to.deep.eq({ ok: false, code: 'invalid_expiry' });
      expect(await t.create(alice, raw({ name: 'x', kind: 'agent', expiresAt: later(60_000) }), ctx)).to.deep.eq({ ok: false, code: 'invalid_scope' });
      expect(await t.create(alice, raw({ name: 'x', kind: 'pat', scope: { agent: true }, expiresAt: later(60_000) }), ctx)).to.deep.eq({ ok: false, code: 'invalid_scope' });
      expect(await t.create(alice, raw({ name: 'x', kind: 'agent', roles: ['admin'], scope: { agent: true }, expiresAt: later(60_000) }), ctx)).to.deep.eq({ ok: false, code: 'invalid_scope' });
    });

    it('validate gives the resolver what it needs, for an agent token too (A15)', async () => {
      const t = new MemoryTokens();
      const pat = await t.create(alice, { name: 'ci', roles: ['dev'], profile: 'dev', scope: { permissions: ['file:read'] }, kind: 'pat', expiresAt: later(DAY) }, ctx);
      const agent = await t.create(alice, { name: 'bot', scope: { permissions: ['file:*'], resources: files, agent: true }, kind: 'agent', expiresAt: later(60_000) }, ctx);
      if (!pat.ok || !agent.ok) throw new Error('create failed');
      const v = await t.validate(pat.plaintext, ctx);
      expect(v).to.deep.include({ ok: true, identity: alice, method: 'token', profile: 'dev' });
      expect((v as Valid).ceiling).to.deep.eq({ roles: ['dev'], permissions: ['file:read'], resources: undefined });
      const a = await t.validate(agent.plaintext, ctx);
      if (!a.ok || !a.delegation) throw new Error('not an agent');
      expect(a.identity).to.deep.eq({ type: 'agent', id: agent.record.id });
      expect(a.delegation).to.deep.eq({ onBehalfOf: alice, mode: 'inherit' });
      expect(a.ceiling).to.deep.eq({ permissions: ['file:*'], resources: files, reason: 'out_of_scope' });
      const outcome: StrategyOutcome = a;
      expect(outcome.ok).to.eq(true);
    });

    it('validate checks revocation, expiry and the owner on every use; revoke is bound to the owner type and id', async () => {
      const t = new MemoryTokens();
      const r = await t.create(alice, { name: 'ci', kind: 'pat', expiresAt: later(DAY) }, ctx);
      if (!r.ok) throw new Error('create failed');
      expect(await t.validate(r.plaintext, { ...ctx, now: later(DAY) })).to.deep.eq({ ok: false, reason: 'expired' });
      t.banned.add('alice');
      expect(await t.validate(r.plaintext, ctx)).to.deep.eq({ ok: false, reason: 'invalid_credentials' });
      t.banned.clear();
      expect(await t.revoke(bob, r.record.id, ctx)).to.eq(false);
      expect(await t.revoke(aliceService, r.record.id, ctx)).to.eq(false);
      expect(await t.list(aliceService)).to.deep.eq([]);
      expect((await t.validate(r.plaintext, ctx)).ok).to.eq(true);
      expect(await t.revoke(alice, r.record.id, ctx, { actor: alice as PrincipalRef })).to.eq(true);
      expect(await t.validate(r.plaintext, ctx)).to.deep.eq({ ok: false, reason: 'revoked' });
      await t.create(alice, { name: 'a', kind: 'pat', expiresAt: later(DAY) }, ctx);
      await t.create(alice, { name: 'b', kind: 'pat', expiresAt: later(DAY) }, ctx);
      expect(await t.revokeAllFor(aliceService, ctx)).to.eq(0);
      expect(await t.revokeAllFor(alice, ctx)).to.eq(2);
      expect(await t.list(alice)).to.deep.eq([]);
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('token.ts holds TokenService with the design methods', () => {
      expect(shapeOf(classMembers('token.ts'))).to.deep.eq({
        TokenService: {
          base: null,
          members: [
            { name: 'create', modifiers: ['abstract'], optional: false, params: ['owner', 'opts', 'ctx'] },
            { name: 'list', modifiers: ['abstract'], optional: false, params: ['owner'] },
            { name: 'revoke', modifiers: ['abstract'], optional: false, params: ['owner', 'id', 'ctx', 'opts'] },
            { name: 'revokeAllFor', modifiers: ['abstract'], optional: false, params: ['owner', 'ctx', 'opts'] },
            { name: 'validate', modifiers: ['abstract'], optional: false, params: ['raw', 'ctx'] },
          ],
        },
      });
    });

    it('TokenKind lists the design kinds in order', () => {
      expect(unionLiterals('token.ts', 'TokenKind')).to.deep.eq(['pat', 'agent', 'service']);
    });

    it('docs carry the rules a reader needs', () => {
      const c = classMembers('token.ts').TokenService;
      expect(c.doc).to.contain('SHA-256');
      for (const s of ['POST /user/tokens', 'fresh auth', 'A13', "'invalid_scope'", 'agent token with roles or a profile', 'invalid_expiry', 'ctx.now']) expect(docOf(c.members, 'create')).to.contain(s);
      expect(docOf(c.members, 'list')).to.contain('GET /user/tokens');
      for (const s of ['DELETE /user/tokens/:uuid', 'Owner-bound', 'same type and id', 'IDOR', 'admin']) expect(docOf(c.members, 'revoke')).to.contain(s);
      for (const s of ['reset', 'A11', 'A25']) expect(docOf(c.members, 'revokeAllFor')).to.contain(s);
      for (const s of ['revocation, expiry and the owner', 'A14', 'A15', 'never thrown']) expect(docOf(c.members, 'validate')).to.contain(s);
      const opts = memberDocs('token.ts', 'TokenCreateOptions');
      for (const s of ['Mandatory', 'authn.token.maxTtlDays', 'agentMaxTtlMinutes', 'A14', 'A15']) expect(opts.expiresAt).to.contain(s);
      expect(opts.roles).to.contain('ceiling.roles');
      expect(opts.roles).to.contain('roles and a profile are refused (invalid_scope)');
      expect(opts.profile).to.contain('authn-token checks it');
      const created = memberDocs('token.ts', 'TokenCreateResult');
      for (const s of ['once', 'never stored or logged', 'A14', 'SR-08']) expect(created.plaintext).to.contain(s);
      const docs = declarationDocs('token.ts');
      expect(docs.TokenRecord).to.contain('Never holds the plaintext or its hash');
      expect(docs.TokenScope).to.contain('A15');
      expect(docs.TokenValidation).to.contain('StrategyOutcome');
      expect(docs.TokenValidation).to.contain('copied to attributes.profile');
      expect(docs.TokenValidation).to.contain("'out_of_scope' and no roles");
      expect(memberDocs('token.ts', 'TokenRecord').id).to.contain('Uuid');
      for (const s of ['2.x Profile', '§18.3(e)', 'never widens']) expect(memberDocs('token.ts', 'TokenRecord').profile).to.contain(s);
      for (const s of ['reaches the principal as attributes.profile through StrategyOutcome.attributes and principalOf', '§18.3(e)']) expect(memberDocs('token.ts', 'TokenValidation').profile).to.contain(s);
    });
  });

  describe('types', () => {
    it('re-exports the token types from the contracts index', () => {
      same<index.TokenService, TokenService>(true);
      same<index.TokenKind, TokenKind>(true);
      same<index.TokenScope, TokenScope>(true);
      same<index.TokenCreateOptions, TokenCreateOptions>(true);
      same<index.TokenRecord, TokenRecord>(true);
      same<index.TokenCreateResult, TokenCreateResult>(true);
      same<index.TokenValidation, TokenValidation>(true);
    });

    it('the token types have the planned shapes', () => {
      same<TokenKind, 'pat' | 'agent' | 'service'>(true);
      same<TokenScope, { readonly permissions?: readonly string[]; readonly resources?: readonly ResourceRef[]; readonly agent?: boolean }>(true);
      same<TokenCreateOptions, { readonly name: string; readonly expiresAt: Date } & ({ readonly kind: 'pat' | 'service'; readonly roles?: readonly string[]; readonly profile?: string; readonly scope?: TokenScope & { readonly agent?: false } } | { readonly kind: 'agent'; readonly roles?: never; readonly profile?: never; readonly scope: TokenScope & { readonly agent: true } })>(true);
      same<
        TokenRecord,
        {
          readonly id: string;
          readonly owner: IdentityRef;
          readonly name: string;
          readonly kind: TokenKind;
          readonly roles?: readonly string[];
          readonly profile?: string;
          readonly scope?: TokenScope;
          readonly createdAt: Date;
          readonly expiresAt: Date;
          readonly lastUsedAt?: Date;
          readonly lastUsedIp?: string;
        }
      >(true);
      same<TokenCreateResult, { readonly ok: true; readonly plaintext: string; readonly record: TokenRecord } | { readonly ok: false; readonly code: 'invalid_expiry' | 'invalid_scope' }>(true);
      same<
        TokenValidation,
        | { readonly ok: true; readonly identity: IdentityRef; readonly method: 'token'; readonly ceiling?: Ceiling; readonly delegation?: never; readonly profile?: string; readonly token: TokenRecord }
        | {
            readonly ok: true;
            readonly identity: { readonly type: 'agent'; readonly id: string };
            readonly method: 'token';
            readonly ceiling: Ceiling & { readonly roles?: never; readonly reason: 'out_of_scope' };
            readonly delegation: Delegation;
            readonly profile?: never;
            readonly token: TokenRecord;
          }
        | { readonly ok: false; readonly reason: AuthnFailure }
      >(true);
    });

    it('members have the planned types', () => {
      type Actor = { readonly actor?: PrincipalRef };
      same<Parameters<TokenService['create']>, [IdentityRef, TokenCreateOptions, AuthnContext]>(true);
      same<ReturnType<TokenService['create']>, Promise<TokenCreateResult>>(true);
      same<Parameters<TokenService['list']>, [IdentityRef]>(true);
      same<ReturnType<TokenService['list']>, Promise<readonly TokenRecord[]>>(true);
      same<Parameters<TokenService['revoke']>, [IdentityRef, string, AuthnContext, Actor?]>(true);
      same<ReturnType<TokenService['revoke']>, Promise<boolean>>(true);
      same<Parameters<TokenService['revokeAllFor']>, [IdentityRef, AuthnContext, Actor?]>(true);
      same<ReturnType<TokenService['revokeAllFor']>, Promise<number>>(true);
      same<Parameters<TokenService['validate']>, [string, AuthnContext]>(true);
      same<ReturnType<TokenService['validate']>, Promise<TokenValidation>>(true);
    });

    it('a validation is a StrategyOutcome, and an agent one always delegates with inherit', async () => {
      const v: TokenValidation = await new MemoryTokens().validate('spt_x', ctx);
      const asOutcome: StrategyOutcome = v;
      void asOutcome;
      if (v.ok && v.identity.type === 'agent' && v.delegation) {
        same<typeof v.delegation.mode, 'inherit'>(true);
        same<typeof v.ceiling.reason, 'out_of_scope'>(true);
      }
      if (!v.ok) {
        // @ts-expect-error a failure carries no token record
        void v.token;
      }
      expect(v).to.deep.eq({ ok: false, reason: 'invalid_credentials' });
    });

    it('wrong shapes do not compile', () => {
      const at = later(DAY);
      // @ts-expect-error abstract
      const a = () => new TokenService();
      // @ts-expect-error expiry is mandatory (A14)
      const b: TokenCreateOptions = { name: 'ci', kind: 'pat' };
      // @ts-expect-error no other kinds
      const c: TokenKind = 'session';
      const r = {} as TokenRecord;
      // @ts-expect-error a listed record holds no plaintext
      void r.plaintext;
      // @ts-expect-error a listed record holds no hash
      void r.hash;
      // @ts-expect-error the scope carries no roles; they have their own option
      const d: TokenScope = { roles: ['admin'] };
      const t: TokenService = new MemoryTokens();
      // @ts-expect-error revoke is owner-bound
      const e = () => t.revoke('t1', ctx);
      // @ts-expect-error an agent validation with another ceiling reason
      const g: TokenValidation = { ok: true, identity: { type: 'agent', id: 't1' }, method: 'token', ceiling: { reason: 'ceiling' }, delegation: { onBehalfOf: alice, mode: 'inherit' }, token: r };
      // @ts-expect-error an agent validation with intersect
      const h: TokenValidation = { ok: true, identity: { type: 'agent', id: 't1' }, method: 'token', ceiling: { reason: 'out_of_scope' }, delegation: { onBehalfOf: alice, mode: 'intersect' }, token: r };
      // @ts-expect-error an agent ceiling carries no roles
      const i: TokenValidation = { ok: true, identity: { type: 'agent', id: 't1' }, method: 'token', ceiling: { roles: ['admin'], reason: 'out_of_scope' }, delegation: { onBehalfOf: alice, mode: 'inherit' }, token: r };
      // @ts-expect-error an agent token takes no roles (A15)
      const j: TokenCreateOptions = { name: 'bot', kind: 'agent', roles: ['admin'], scope: { agent: true }, expiresAt: at };
      // @ts-expect-error an agent token takes no profile
      const k: TokenCreateOptions = { name: 'bot', kind: 'agent', profile: 'dev', scope: { agent: true }, expiresAt: at };
      // @ts-expect-error an agent token needs scope.agent
      const l: TokenCreateOptions = { name: 'bot', kind: 'agent', expiresAt: at };
      // @ts-expect-error only an agent token sets scope.agent
      const m: TokenCreateOptions = { name: 'ci', kind: 'pat', scope: { agent: true }, expiresAt: at };
      // @ts-expect-error create takes the clock from ctx
      const n = () => t.create(alice, { name: 'ci', kind: 'pat', expiresAt: at });
      expect([a, b, c, d, e, g, h, i, j, k, l, m, n]).to.have.length(13);
    });
  });
});
