/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- the tamper tests write into hook inputs untyped, as a careless hook would */
import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { ActionRefused } from '@spinajs/hooks';
import { AuthnAudit } from '@spinajs/authn/audit';
import type { AuthnContext, IdentityRef, TokenCreateOptions, TokenCreateResult } from '@spinajs/authn/contracts';
import { FakeIdentityStore, RecordingEventSink, ScriptedActionHook, kitHooks } from '@spinajs/authn-testing';

import '../src/generator.js';
import { DbTokenService, NoTokenProfilesPolicy } from '../src/service/index.js';
import { bootV3Db, insertUserRow, shutdownV3Db } from './v3/db.js';
import { tokenServiceOver } from './v3/services.js';

const DAY = 86_400_000;
const CODE = 'not-today';
const ctx = (): AuthnContext => ({ now: new Date(), purpose: 'request' });
const at = (ms: number): Date => new Date(Date.now() + ms);

type Ok = Extract<TokenCreateResult, { ok: true }>;

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('DbTokenService action hooks', function () {
  this.timeout(15000);

  let identities: FakeIdentityStore;
  let hook: ScriptedActionHook;
  let warnings: unknown[][];
  let tokens: DbTokenService;

  before(async () => {
    await bootV3Db();
  });

  after(async () => {
    await shutdownV3Db();
  });

  beforeEach(async () => {
    identities = new FakeIdentityStore();
    hook = new ScriptedActionHook();
    warnings = [];
    const hooks = await kitHooks([hook], { log: { warn: (...args: unknown[]) => void warnings.push(args) } });
    tokens = await tokenServiceOver({ identities, profiles: new NoTokenProfilesPolicy(), auditor: AuthnAudit.over([new RecordingEventSink()]), hooks });
  });

  async function owner(): Promise<IdentityRef> {
    const ref = identities.add({ login: randomUUID() });
    await insertUserRow(ref.id);
    return ref;
  }

  const opts = (over: Record<string, unknown> = {}) => ({ name: 'pat', kind: 'pat', expiresAt: at(DAY), ...over }) as unknown as TokenCreateOptions;

  async function pat(o: IdentityRef, over: Record<string, unknown> = {}): Promise<Ok> {
    const r = await tokens.create(o, opts(over), ctx());
    if (!r.ok) throw new Error(`not minted: ${JSON.stringify(r)}`);
    return r;
  }

  describe('create', () => {
    it('refused throws ActionRefused and stores no token', async () => {
      const a = await owner();
      hook.refuse('authn.token.create', CODE);
      const err = await rejection(tokens.create(a, opts(), ctx()));
      expect(err).to.be.instanceOf(ActionRefused);
      expect((err as ActionRefused).code).to.equal(CODE);
      expect(await tokens.list(a)).to.deep.equal([]);
    });

    it('a hook raising the expiry above authn.token.maxTtlDays is refused by the service', async () => {
      const a = await owner();
      hook.mutate('authn.token.create', (input) => ({ opts: { ...(input.opts as object), expiresAt: at(10_000 * DAY) } }));
      expect({ ...(await tokens.create(a, opts(), ctx())) }).to.deep.equal({ ok: false, code: 'invalid_expiry' });
      expect(await tokens.list(a)).to.deep.equal([]);
    });

    it('a hook widening the scope is refused by the service', async () => {
      const a = await owner();
      const scoped = opts({ scope: { permissions: ['doc:read'], resources: [{ type: 'doc', id: '1' }] } });
      const widenings: Record<string, unknown>[] = [
        { scope: undefined },
        { scope: { permissions: ['doc:read', 'doc:write'], resources: [{ type: 'doc', id: '1' }] } },
        { scope: { permissions: ['doc:read'] } },
        { scope: { permissions: ['doc:read'], resources: [{ type: 'doc' }] } },
      ];
      for (const patch of widenings) {
        hook.reset();
        hook.mutate('authn.token.create', (input) => ({ opts: { ...(input.opts as object), ...patch } }));
        expect({ ...(await tokens.create(a, scoped, ctx())) }, JSON.stringify(patch)).to.deep.equal({ ok: false, code: 'invalid_scope' });
      }
      expect(await tokens.list(a)).to.deep.equal([]);
    });

    it('a hook narrowing the scope or the expiry is taken', async () => {
      const a = await owner();
      const expiresAt = at(DAY / 2);
      hook.mutate('authn.token.create', (input) => ({ opts: { ...(input.opts as object), expiresAt, scope: { permissions: ['doc:read'] } } }));
      const t = await pat(a, { scope: { permissions: ['doc:read', 'doc:write'] } });
      expect(t.record.scope).to.deep.equal({ permissions: ['doc:read'] });
      expect(Math.floor(t.record.expiresAt.getTime() / 1000)).to.equal(Math.floor(expiresAt.getTime() / 1000));
    });

    it('after hooks see the record but never the plaintext', async () => {
      const a = await owner();
      const t = await pat(a);
      expect(hook.calls('authn.token.create').map((c) => c.phase)).to.deep.equal(['before', 'after']);
      const output = hook.calls('authn.token.create')[1].output as Record<string, unknown>;
      expect(output).to.not.have.property('plaintext');
      expect(JSON.stringify(hook.calls())).to.not.contain(t.plaintext);
    });
  });

  describe('hooks get copies', () => {
    it('a hook writing ctx.now or opts in place does not move the expiry check, and the stored record ignores output writes', async () => {
      const a = await owner();
      hook.tamper('authn.token.create', (i) => {
        i.ctx.now.setTime(0);
      });
      hook.tamper('authn.token.create', (o) => {
        o.record.name = 'evil';
      }, 'after');
      const t = await pat(a);
      expect(t.record.name).to.equal('pat');
      // Freezing a Date does not stop setTime: the before write lands, on the hook's own copy.
      expect(hook.landed()).to.deep.equal(['authn.token.create:before']);
    });

    it('a hook writing the owner of a revoke or an update in place does not move either', async () => {
      const a = await owner();
      const b = await owner();
      const t = await pat(a);
      hook.tamper('authn.token.*', (i) => {
        i.owner.id = b.id;
      });
      expect((await tokens.update(a, t.record.id, { name: 'renamed' }, ctx())).ok).to.equal(true);
      expect((await tokens.list(a))[0].name).to.equal('renamed');
      expect(await tokens.revoke(a, t.record.id, ctx())).to.equal(true);
      expect((await tokens.validate(t.plaintext, ctx())).ok).to.equal(false);
      expect(hook.landed()).to.deep.equal([]);
    });

    it('a hook writing the owner of a rotation in place does not move the rotation', async () => {
      const a = await owner();
      const b = await owner();
      const t = await pat(a);
      hook.tamper('authn.token.rotate', (i) => {
        i.owner.id = b.id;
      });
      const r = await tokens.rotate(a, t.record.id, ctx());
      expect(r.ok).to.equal(true);
      expect(hook.landed()).to.deep.equal([]);
    });
  });

  describe('revoke', () => {
    it('refused keeps the token valid', async () => {
      const a = await owner();
      const t = await pat(a);
      hook.refuse('authn.token.revoke', CODE);
      expect(await rejection(tokens.revoke(a, t.record.id, ctx()))).to.be.instanceOf(ActionRefused);
      expect((await tokens.validate(t.plaintext, ctx())).ok).to.equal(true);
    });
  });

  describe('rotate and update', () => {
    it('a refused rotation keeps the old secret and issues none', async () => {
      const a = await owner();
      const t = await pat(a);
      hook.refuse('authn.token.rotate', CODE);
      expect(await rejection(tokens.rotate(a, t.record.id, ctx()))).to.be.instanceOf(ActionRefused);
      expect((await tokens.validate(t.plaintext, ctx())).ok).to.equal(true);
    });

    it('a refused update changes nothing', async () => {
      const a = await owner();
      const t = await pat(a);
      hook.refuse('authn.token.update', CODE);
      expect(await rejection(tokens.update(a, t.record.id, { name: 'renamed' }, ctx()))).to.be.instanceOf(ActionRefused);
      expect((await tokens.list(a))[0].name).to.equal('pat');
    });

    it('a hook that makes an update widen the token is refused by the narrowing check', async () => {
      const a = await owner();
      const t = await pat(a);
      hook.mutate('authn.token.update', { opts: { expiresAt: at(2 * DAY) } });
      expect({ ...(await tokens.update(a, t.record.id, { expiresAt: at(DAY / 2) }, ctx())) }).to.deep.equal({ ok: false, reason: 'invalid_expiry' });
    });
  });

  describe('self-revocation and revokeAllFor', () => {
    it('a refusing hook on revokeByPlaintext is logged and the token is revoked', async () => {
      const a = await owner();
      const t = await pat(a);
      hook.refuse('authn.token.selfRevoke', CODE);
      expect(await tokens.revokeByPlaintext(t.plaintext, ctx())).to.equal(true);
      expect((await tokens.validate(t.plaintext, ctx())).ok).to.equal(false);
      expect(warnings.length, 'the refusal is logged').to.be.greaterThan(0);
      expect(hook.calls('authn.token.selfRevoke').map((c) => c.phase)).to.deep.equal(['before', 'after']);
      expect(JSON.stringify(hook.calls())).to.not.contain(t.plaintext);
    });

    it('revokeAllFor never runs hooks', async () => {
      const a = await owner();
      await pat(a);
      hook.reset();
      hook.refuse('*', CODE);
      expect(await tokens.revokeAllFor(a, ctx())).to.equal(1);
      expect(hook.calls()).to.deep.equal([]);
    });
  });
});
