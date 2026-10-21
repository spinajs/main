import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { PasswordService } from '@spinajs/authn/contracts';
import type { AddressVerificationRequestResult, AddressVerificationResult, AuthnContext, IdentityRef, PasswordPolicy } from '@spinajs/authn/contracts';

import { PASSWORD_HARD_CAP } from '../../../src/v3/index.js';
import { Client, bind, loggedIn, rebuildServer, seedUser, step, tokens } from '../app.js';
import type { Res } from '../app.js';
import { mountedRoutes } from './route-table.js';

export const VERIFICATION_ROUTES_V3 = ['POST /auth/verify/request', 'POST /auth/verify'];

type Call = { method: 'requestVerification' | 'redeemVerification'; args: unknown[] };

/** Records the verification calls; the password flows are not routes of this suite. */
class VerifyingPasswordService extends PasswordService {
  public calls: Call[] = [];
  public answer: { request?: () => Promise<AddressVerificationRequestResult>; redeem?: () => Promise<AddressVerificationResult> } = {};

  public reset(): void {
    this.calls = [];
    this.answer = {};
  }

  public of(method: Call['method']): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  public async requestVerification(id: IdentityRef, ctx: AuthnContext): Promise<AddressVerificationRequestResult> {
    this.calls.push({ method: 'requestVerification', args: [id, ctx] });
    return this.answer.request ? this.answer.request() : { status: 'accepted' };
  }

  public async redeemVerification(secret: string, ctx: AuthnContext): Promise<AddressVerificationResult> {
    this.calls.push({ method: 'redeemVerification', args: [secret, ctx] });
    return this.answer.redeem ? this.answer.redeem() : { status: 'verified' };
  }

  public policy(): PasswordPolicy {
    return { minLength: 8, maxLength: 128 };
  }

  public change(): never {
    throw new Error('not a route');
  }

  public requestReset(): never {
    throw new Error('not a route');
  }

  public redeemReset(): never {
    throw new Error('not a route');
  }

  public invite(): never {
    throw new Error('not a route');
  }

  public check(): never {
    throw new Error('not a route');
  }

  public set(): never {
    throw new Error('not a route');
  }

  public expire(): never {
    throw new Error('not a route');
  }
}

const fake = new VerifyingPasswordService();

const ACK = { Ok: true };

function expectInvalidSecret(res: Res): void {
  expect(res.status, JSON.stringify(res.body)).to.eq(400);
  expect(res.body).to.deep.eq({ error: 'invalid_secret', message: 'the verification link is invalid or has expired' });
  expect(res.headers['cache-control']).to.eq('no-store');
}

/** The routes over a recording PasswordService that offers verification. */
export function verificationRoutesSuite(): void {
  before(async () => {
    bind(PasswordService, 'V3AppVerifyingPasswordService', () => fake);
    await rebuildServer();
  });

  beforeEach(() => fake.reset());

  it('mounts both routes once', async () => {
    const routes = await mountedRoutes();
    for (const route of VERIFICATION_ROUTES_V3) expect(routes.filter((r) => r === route), route).to.have.length(1);
  });

  describe('POST /auth/verify/request', () => {
    it('without a session answers 401 and never reaches the service', async () => {
      const res = await new Client().post('/auth/verify/request', {});
      expect(res.status).to.eq(401);
      expect(res.body.error).to.eq('unauthenticated');
      expect(fake.of('requestVerification')).to.deep.eq([]);
    });

    it('with a session answers 202 without caching and asks for the session identity, with the client ip', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      const res = await c.post('/auth/verify/request', {});
      expect(res.status, JSON.stringify(res.body)).to.eq(202);
      expect(res.body).to.deep.eq(ACK);
      expect(res.headers['cache-control']).to.eq('no-store');
      const [id, ctx] = fake.of('requestVerification')[0].args as [IdentityRef, AuthnContext];
      expect(id).to.deep.eq(u.ref);
      expect(ctx.purpose).to.eq('request');
      expect(typeof ctx.ip).to.eq('string');
    });

    it('a throttled request answers 429 with Retry-After', async () => {
      const c = await loggedIn(await seedUser());
      fake.answer.request = async () => ({ status: 'throttled', retryAfterSeconds: 59.5 });
      const res = await c.post('/auth/verify/request', {});
      expect(res.status).to.eq(429);
      expect(res.body.error).to.eq('throttled');
      expect(res.headers['retry-after']).to.eq('60');
    });

    it('a pending session gets 401 and a token gets 403 session_required', async () => {
      const u = await seedUser();
      step.enrol(u.ref);
      const pending = new Client();
      expect((await pending.post('/auth/login', { login: u.login, password: u.password })).body).to.have.property('MfaRequired');
      expect((await pending.post('/auth/verify/request', {})).status).to.eq(401);

      const v = await seedUser();
      const token = `spt_${randomUUID()}`;
      tokens.set(token, v.ref);
      const byToken = await new Client().post('/auth/verify/request', {}, { Authorization: `Bearer ${token}` });
      expect(byToken.status).to.eq(403);
      expect(byToken.body.error).to.eq('session_required');
      expect(fake.of('requestVerification')).to.deep.eq([]);
    });
  });

  describe('POST /auth/verify', () => {
    it('a valid secret answers 200 to an anonymous caller and hands the secret to redeemVerification', async () => {
      const res = await new Client().post('/auth/verify', { secret: 'kit-verify-secret' });
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.body).to.deep.eq(ACK);
      expect(res.headers['cache-control']).to.eq('no-store');
      const [secret, ctx] = fake.of('redeemVerification')[0].args as [string, AuthnContext];
      expect(secret).to.eq('kit-verify-secret');
      expect(ctx.purpose).to.eq('request');
    });

    it('an invalid secret answers 400 with one body, the same for a missing or over-long secret, which never reach the service', async () => {
      fake.answer.redeem = async () => ({ status: 'invalid' });
      expectInvalidSecret(await new Client().post('/auth/verify', { secret: 'wrong' }));
      expect(fake.of('redeemVerification')).to.have.length(1);
      for (const body of [{}, { secret: '' }, { secret: 42 }, { secret: 'x'.repeat(PASSWORD_HARD_CAP + 1) }]) {
        expectInvalidSecret(await new Client().post('/auth/verify', body));
      }
      expect(fake.of('redeemVerification')).to.have.length(1);
    });
  });
}
