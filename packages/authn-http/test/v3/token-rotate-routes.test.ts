import 'mocha';
import { expect } from 'chai';
import { CONTROLLED_DESCRIPTOR_SYMBOL, RouteType } from '@spinajs/http';
import type { IContainer } from '@spinajs/di';
import type { IControllerDescriptor, Request } from '@spinajs/http';
import { FreshAuthCheck } from '@spinajs/authn';
import { IdentityStore, TokenService } from '@spinajs/authn/contracts';
import type { IdentityRef, TokenRecord, TokenRotateResult, TokenUpdate, TokenUpdateResult } from '@spinajs/authn/contracts';

import { AuthnTokensController } from '../../src/v3/controllers/AuthnTokensController.js';
import { callRoute, withParams } from '../support/route-call.js';

const ALICE: IdentityRef = { type: 'user', id: 'alice' };
const TOKEN_ID = '5b0f35c8-7d0d-4d4e-9d59-8a3f9a7c1e11';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FRESH_MAX_AGE_SECONDS = 300;

const record = (over: Partial<TokenRecord> = {}): TokenRecord => ({ id: TOKEN_ID, owner: ALICE, name: 'laptop', kind: 'pat', roles: ['viewer'], createdAt: new Date('2026-10-01T10:00:00Z'), expiresAt: new Date('2026-11-01T10:00:00Z'), ...over });

interface Call {
  readonly method: 'rotate' | 'update';
  readonly args: unknown[];
}

class StubTokenService extends TokenService {
  public readonly calls: Call[] = [];
  public rotated: TokenRotateResult = { ok: true, plaintext: 'spt_new-secret', token: record() };
  public updated: TokenUpdateResult = { ok: true, token: record({ name: 'renamed' }) };

  public async rotate(...args: Parameters<TokenService['rotate']>): Promise<TokenRotateResult> {
    this.calls.push({ method: 'rotate', args });
    return this.rotated;
  }

  public async update(...args: Parameters<TokenService['update']>): Promise<TokenUpdateResult> {
    this.calls.push({ method: 'update', args });
    return this.updated;
  }

  public async create(): Promise<never> {
    throw new Error('not used');
  }

  public async list(): Promise<never> {
    throw new Error('not used');
  }

  public async revoke(): Promise<never> {
    throw new Error('not used');
  }

  public async revokeAllFor(): Promise<never> {
    throw new Error('not used');
  }

  public async revokeByPlaintext(): Promise<never> {
    throw new Error('not used');
  }

  public async validate(): Promise<never> {
    throw new Error('not used');
  }
}

interface World {
  readonly controller: AuthnTokensController;
  readonly tokens: StubTokenService;
  /** Passwords the stub FreshAuthCheck was asked to verify. */
  readonly verified: string[];
  request(body: unknown, authenticatedAgoMs?: number): Request;
}

function world(correctPassword = 'Correct-Pass-1'): World {
  const tokens = new StubTokenService();
  const verified: string[] = [];
  const services = new Map<unknown, unknown>([
    [TokenService, tokens],
    [FreshAuthCheck, { maxAgeSeconds: FRESH_MAX_AGE_SECONDS, check: async (_handle: unknown, _ctx: unknown, credentials: { password: string }) => (verified.push(credentials.password), credentials.password === correctPassword) }],
    [IdentityStore, { display: async () => ({ email: 'alice@example.test' }) }],
  ]);
  const container = { resolve: async (type: unknown) => services.get(type) } as unknown as IContainer;
  const controller = new AuthnTokensController();
  (controller as unknown as { Container: IContainer }).Container = container;

  const request = (body: unknown, authenticatedAgoMs = 0): Request => {
    const handle = { state: 'active', id: 'handle-1' };
    const authn = { sessionHandle: 'handle-1', authenticatedAt: new Date(Date.now() - authenticatedAgoMs), method: 'password' };
    return {
      body,
      headers: { 'user-agent': 'mocha' },
      storage: {
        ClientIp: '192.0.2.7',
        AuthnPrincipal: { ...ALICE, authenticated: true, source: 'session', attributes: {}, authn },
        AuthnSession: { identity: ALICE, handle, facts: authn },
      },
    } as unknown as Request;
  };
  return { controller, tokens, verified, request };
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly noStore: boolean;
}

/** What the response would send, read off the response object without an express round trip. */
function answerOf(res: unknown): Answer {
  const r = res as { _errorCode: number; responseData: Record<string, unknown>; options?: { Headers?: { Name: string; Value: string }[] } };
  return { status: r._errorCode, body: r.responseData, noStore: (r.options?.Headers ?? []).some((h) => h.Name === 'Cache-Control' && h.Value === 'no-store') };
}

const rejection = async (promise: Promise<unknown>): Promise<{ error?: unknown; name: string }> => {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'the call should have thrown').to.be.instanceOf(Error);
  return { error: (err as { error?: unknown }).error, name: (err as Error).constructor.name };
};

describe('token rotate and update routes', () => {
  describe('route table', () => {
    const descriptor = (): IControllerDescriptor => Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AuthnTokensController.prototype) as IControllerDescriptor;

    it('mounts POST tokens/:uuid/rotate and PATCH tokens/:uuid beside the three existing routes', () => {
      const routes = descriptor().Routes;
      expect(routes.get('rotate')).to.include({ Type: RouteType.POST, Path: 'tokens/:uuid/rotate' });
      expect(routes.get('update')).to.include({ Type: RouteType.PATCH, Path: 'tokens/:uuid' });
    });
  });

  describe('POST /user/tokens/:uuid/rotate', () => {
    it('rotates the caller\'s token and answers the entry and the new plaintext once, with no-store', async () => {
      const w = world();
      const res = answerOf(await callRoute(w.controller, 'rotate', withParams(w.request({ graceSeconds: 90 }), { uuid: TOKEN_ID })));

      expect(res.status).to.eq(200);
      expect(res.noStore).to.eq(true);
      expect(Object.keys(res.body).sort()).to.deep.eq(['Plaintext', 'Token']);
      expect(res.body.Plaintext).to.eq('spt_new-secret');
      expect(res.body.Token).to.deep.include({ Uuid: TOKEN_ID, Name: 'laptop', Kind: 'pat', Roles: ['viewer'] });
      expect(JSON.stringify(res.body.Token)).to.not.include('spt_new-secret');

      expect(w.tokens.calls).to.have.length(1);
      const [owner, id, ctx, opts] = w.tokens.calls[0].args as [IdentityRef, string, { purpose: string; ip?: string }, unknown];
      expect(owner).to.deep.eq(ALICE);
      expect(id).to.eq(TOKEN_ID);
      expect(ctx).to.include({ purpose: 'request', ip: '192.0.2.7' });
      expect(opts).to.deep.eq({ graceSeconds: 90 });
    });

    it('passes no options when the body has no graceSeconds, and 0 as given', async () => {
      const w = world();
      await callRoute(w.controller, 'rotate', withParams(w.request({}), { uuid: TOKEN_ID }));
      await callRoute(w.controller, 'rotate', withParams(w.request(undefined), { uuid: TOKEN_ID }));
      await callRoute(w.controller, 'rotate', withParams(w.request({ graceSeconds: 0 }), { uuid: TOKEN_ID }));
      expect(w.tokens.calls.map((c) => c.args[3])).to.deep.eq([undefined, undefined, { graceSeconds: 0 }]);
    });

    it('answers 400 invalid_grace for a grace that is not a whole number from 0 to 604800, and rotates nothing', async () => {
      const w = world();
      for (const graceSeconds of [-1, 1.5, '60', null, true, [], {}, 604_801]) {
        const res = answerOf(await callRoute(w.controller, 'rotate', withParams(w.request({ graceSeconds }), { uuid: TOKEN_ID })));
        expect(res.status, JSON.stringify(graceSeconds)).to.eq(400);
        expect(res.body.error).to.eq('invalid_grace');
        expect(res.noStore).to.eq(true);
      }
      expect(w.tokens.calls).to.deep.eq([]);
      expect(answerOf(await callRoute(w.controller, 'rotate', withParams(w.request({ graceSeconds: 604_800 }), { uuid: TOKEN_ID }))).status).to.eq(200);
    });

    it('answers one 404 token_not_found for a token the service does not find, an empty and an over-long id', async () => {
      const w = world();
      w.tokens.rotated = { ok: false, reason: 'not_found' };
      const missing = answerOf(await callRoute(w.controller, 'rotate', withParams(w.request({}), { uuid: TOKEN_ID })));
      expect(missing.status).to.eq(404);
      expect(missing.body.error).to.eq('token_not_found');
      expect(missing.noStore).to.eq(true);

      const calls = w.tokens.calls.length;
      for (const id of ['', 'x'.repeat(65)]) {
        const res = answerOf(await callRoute(w.controller, 'rotate', withParams(w.request({}), { uuid: id })));
        expect(res, JSON.stringify(id)).to.deep.eq(missing);
      }
      expect(w.tokens.calls, 'a malformed id never reaches the service').to.have.length(calls);
    });

    it('needs fresh auth: a stale session without the password is refused 403 fresh_auth_required', async () => {
      const w = world();
      const refusal = await rejection(callRoute(w.controller, 'rotate', withParams(w.request({}, HOUR), { uuid: TOKEN_ID })));
      expect(refusal.error).to.eq('fresh_auth_required');
      expect(w.tokens.calls).to.deep.eq([]);
      expect(w.verified).to.deep.eq([]);
    });

    it('a stale session rotates with the right reauthPassword, which is taken out of the body first', async () => {
      const w = world();
      const body = { graceSeconds: 5, reauthPassword: 'Correct-Pass-1' };
      const res = answerOf(await callRoute(w.controller, 'rotate', withParams(w.request(body, HOUR), { uuid: TOKEN_ID })));

      expect(res.status).to.eq(200);
      expect(w.verified).to.deep.eq(['Correct-Pass-1']);
      expect(body).to.not.have.property('reauthPassword');
      expect(w.tokens.calls.map((c) => c.args[3])).to.deep.eq([{ graceSeconds: 5 }]);
    });

    it('a wrong reauthPassword answers the login failure with 401 and rotates nothing', async () => {
      const w = world();
      const res = answerOf(await callRoute(w.controller, 'rotate', withParams(w.request({ reauthPassword: 'Wrong-Pass-1' }, HOUR), { uuid: TOKEN_ID })));
      expect(res.status).to.eq(401);
      expect(w.tokens.calls).to.deep.eq([]);
      expect(JSON.stringify(res.body)).to.not.include('Wrong-Pass-1');
    });

    it('a fresh session needs no password', async () => {
      const w = world();
      expect(answerOf(await callRoute(w.controller, 'rotate', withParams(w.request({}, MINUTE), { uuid: TOKEN_ID }))).status).to.eq(200);
      expect(w.verified).to.deep.eq([]);
    });
  });

  describe('PATCH /user/tokens/:uuid', () => {
    it('narrows the caller\'s token and answers the entry with no-store', async () => {
      const w = world();
      const expiresAt = '2026-10-25T10:00:00.000Z';
      const res = answerOf(await callRoute(w.controller, 'update', withParams(w.request({ name: 'renamed', roles: ['viewer'], expiresAt }), { uuid: TOKEN_ID })));

      expect(res.status).to.eq(200);
      expect(res.noStore).to.eq(true);
      expect(Object.keys(res.body)).to.deep.eq(['Token']);
      expect(res.body.Token).to.deep.include({ Uuid: TOKEN_ID, Name: 'renamed' });

      const [owner, id, change, ctx] = w.tokens.calls[0].args as [IdentityRef, string, TokenUpdate, { purpose: string }];
      expect(owner).to.deep.eq(ALICE);
      expect(id).to.eq(TOKEN_ID);
      expect(change).to.deep.eq({ name: 'renamed', roles: ['viewer'], expiresAt: new Date(expiresAt) });
      expect(ctx.purpose).to.eq('request');
    });

    it('passes only the fields the body has, and an empty body as no change', async () => {
      const w = world();
      await callRoute(w.controller, 'update', withParams(w.request({ name: 'only a name' }), { uuid: TOKEN_ID }));
      await callRoute(w.controller, 'update', withParams(w.request({}), { uuid: TOKEN_ID }));
      expect(w.tokens.calls.map((c) => c.args[2])).to.deep.eq([{ name: 'only a name' }, {}]);
    });

    it('needs no fresh auth, because it only narrows', async () => {
      const w = world();
      const res = answerOf(await callRoute(w.controller, 'update', withParams(w.request({ name: 'renamed' }, 24 * HOUR), { uuid: TOKEN_ID })));
      expect(res.status).to.eq(200);
      expect(w.verified).to.deep.eq([]);
    });

    it('answers 400 with a stable code for a malformed field, and changes nothing', async () => {
      const w = world();
      const rows: [string, Record<string, unknown>][] = [
        ['invalid_name', { name: '' }],
        ['invalid_name', { name: '   ' }],
        ['invalid_name', { name: 42 }],
        ['invalid_name', { name: 'n'.repeat(129) }],
        ['invalid_roles', { roles: 'viewer' }],
        ['invalid_roles', { roles: [] }],
        ['invalid_roles', { roles: [42] }],
        ['invalid_roles', { roles: ['r'.repeat(129)] }],
        ['invalid_roles', { roles: Array.from({ length: 65 }, (_, i) => `role${i}`) }],
        ['invalid_expiry', { expiresAt: null }],
        ['invalid_expiry', { expiresAt: 'next week' }],
        ['invalid_expiry', { expiresAt: Date.now() }],
        ['invalid_expiry', { expiresAt: '2026-02-30T00:00:00Z' }],
      ];
      for (const [error, body] of rows) {
        const res = answerOf(await callRoute(w.controller, 'update', withParams(w.request(body), { uuid: TOKEN_ID })));
        expect([res.status, res.body.error, res.noStore], JSON.stringify(body)).to.deep.eq([400, error, true]);
      }
      expect(w.tokens.calls).to.deep.eq([]);
    });

    it('answers 400 invalid_field for a key that is not name, roles or expiresAt, so a body cannot widen or retarget a token', async () => {
      const w = world();
      for (const body of [{ kind: 'agent' }, { profile: 'admin' }, { scope: { agent: true } }, { Token: 'x' }, { name: 'ok', user_id: 9 }, { reauthPassword: 'x' }]) {
        const res = answerOf(await callRoute(w.controller, 'update', withParams(w.request(body), { uuid: TOKEN_ID })));
        expect([res.status, res.body.error], JSON.stringify(body)).to.deep.eq([400, 'invalid_field']);
      }
      expect(w.tokens.calls).to.deep.eq([]);
    });

    it('maps invalid_scope and invalid_expiry from the service to 400, and not_found to the one 404', async () => {
      const w = world();
      w.tokens.updated = { ok: false, reason: 'invalid_scope' };
      const scope = answerOf(await callRoute(w.controller, 'update', withParams(w.request({ roles: ['admin'] }), { uuid: TOKEN_ID })));
      expect([scope.status, scope.body.error, scope.noStore]).to.deep.eq([400, 'invalid_scope', true]);

      w.tokens.updated = { ok: false, reason: 'invalid_expiry' };
      const expiry = answerOf(await callRoute(w.controller, 'update', withParams(w.request({ expiresAt: '2030-01-01T00:00:00Z' }), { uuid: TOKEN_ID })));
      expect([expiry.status, expiry.body.error, expiry.noStore]).to.deep.eq([400, 'invalid_expiry', true]);

      w.tokens.updated = { ok: false, reason: 'not_found' };
      const missing = answerOf(await callRoute(w.controller, 'update', withParams(w.request({ name: 'x' }), { uuid: TOKEN_ID })));
      expect([missing.status, missing.body.error, missing.noStore]).to.deep.eq([404, 'token_not_found', true]);
      for (const id of ['', 'x'.repeat(65)]) {
        expect(answerOf(await callRoute(w.controller, 'update', withParams(w.request({ name: 'x' }), { uuid: id }))), JSON.stringify(id)).to.deep.eq(missing);
      }
      expect(w.tokens.calls, 'a malformed id never reaches the service').to.have.length(3);
    });
  });
});
