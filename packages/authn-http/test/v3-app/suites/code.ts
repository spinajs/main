import { expect } from 'chai';
import { Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { IController, IRoute, Request } from '@spinajs/http';
import { PasswordService } from '@spinajs/authn/contracts';
import type { AuthnContext, CodeRequestResult, PasswordPolicy } from '@spinajs/authn/contracts';

import { CodeLoginRegistered } from '../../../src/password/index.js';
import { AUTHN_FAILURE_BODY, PASSWORD_HARD_CAP } from '../../../src/v3/index.js';
import { AUTHN_PROBE_PATH } from '../../v3/probe.js';
import { Client, KIT_CODE, V3AppResponseExtension, bind, identities, rebuildServer, resetRecorders, seedUser } from '../app.js';
import { mountedRoutes } from './route-table.js';

export const CODE_ROUTES_V3 = ['POST /auth/code/request', 'POST /auth/code/login'];

type Call = { login: string; ctx: AuthnContext };

/** Records the code requests; the password flows are not routes of this suite. */
class CodingPasswordService extends PasswordService {
  public calls: Call[] = [];
  public answer: { request?: () => Promise<CodeRequestResult> } = {};

  public reset(): void {
    this.calls = [];
    this.answer = {};
  }

  public async requestCode(login: string, ctx: AuthnContext): Promise<CodeRequestResult> {
    this.calls.push({ login, ctx });
    return this.answer.request ? this.answer.request() : { status: 'accepted' };
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

const fake = new CodingPasswordService();

const ACK = { Ok: true };
const probe = async (c: Client) => (await c.get(`/${AUTHN_PROBE_PATH}`)).body as { principal: { id: string } };

/** The gate on containers of its own: closed until a PasswordService that sends codes is registered. */
export function codeGateSuite(): void {
  it('the gate asks the container it resolves from and stays closed until the PasswordService offers requestCode', async () => {
    const route = {} as IRoute;
    const ctrl = {} as IController;
    const req = { storage: {} } as unknown as Request;
    const notFound = (e: { constructor: { name: string } }) => expect(e.constructor.name).to.eq('ResourceNotFound');
    const gateOver = (container: IContainer) => {
      const gate = new CodeLoginRegistered();
      (gate as unknown as { Container: unknown }).Container = container;
      return gate;
    };

    const none = new Container();
    expect(gateOver(none).isEnabled(route, ctrl)).to.eq(true);
    await gateOver(none)
      .execute(req, route, ctrl)
      .then(() => expect.fail('the gate passed without a PasswordService'), notFound);

    const plain = none.child();
    plain.register({ StubPlainPasswordService: () => ({}) }.StubPlainPasswordService).as(PasswordService as never);
    await gateOver(plain)
      .execute(req, route, ctrl)
      .then(() => expect.fail('the gate passed for a PasswordService without requestCode'), notFound);

    const coding = none.child();
    coding.register({ StubCodingPasswordService: () => ({ requestCode: async () => ({ status: 'accepted' }) }) }.StubCodingPasswordService).as(PasswordService as never);
    await gateOver(coding).execute(req, route, ctrl);
  });
}

/** The routes over a recording PasswordService that offers code requests. */
export function codeRoutesSuite(): void {
  before(async () => {
    bind(PasswordService, 'V3AppCodingPasswordService', () => fake);
    await rebuildServer();
  });

  beforeEach(() => {
    fake.reset();
    resetRecorders();
  });

  it('mounts both routes once', async () => {
    const routes = await mountedRoutes();
    for (const route of CODE_ROUTES_V3) expect(routes.filter((r) => r === route), route).to.have.length(1);
  });

  describe('POST /auth/code/request', () => {
    it('answers 202 to an anonymous caller without caching, and asks for the login with the client ip', async () => {
      const u = await seedUser();
      const res = await new Client().post('/auth/code/request', { login: u.login });
      expect(res.status, JSON.stringify(res.body)).to.eq(202);
      expect(res.body).to.deep.eq(ACK);
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(fake.calls).to.have.length(1);
      expect(fake.calls[0].login).to.eq(u.login);
      expect(fake.calls[0].ctx.purpose).to.eq('request');
      expect(typeof fake.calls[0].ctx.ip).to.eq('string');
    });

    it('answers the same 202 for a login nobody has', async () => {
      const res = await new Client().post('/auth/code/request', { login: 'nobody@example.test' });
      expect(res.status).to.eq(202);
      expect(res.body).to.deep.eq(ACK);
    });

    it('a throttled request answers 429 with Retry-After', async () => {
      fake.answer.request = async () => ({ status: 'throttled', retryAfterSeconds: 59.5 });
      const res = await new Client().post('/auth/code/request', { login: 'someone@example.test' });
      expect(res.status).to.eq(429);
      expect((res.body as { error?: string }).error).to.eq('throttled');
      expect(res.headers['retry-after']).to.eq('60');
    });

    it('a failing service still answers 202, so the answer does not tell a failed lookup or mail', async () => {
      fake.answer.request = async () => {
        throw new Error('mail down for someone@example.test');
      };
      const res = await new Client().post('/auth/code/request', { login: 'someone@example.test' });
      expect(res.status).to.eq(202);
      expect(JSON.stringify(res.body)).to.not.contain('someone@example.test');
    });

    it('a missing, empty, non-string or over-long login answers 400 invalid_login and never reaches the service', async () => {
      for (const body of [{}, { login: '' }, { login: 42 }, { login: 'x'.repeat(PASSWORD_HARD_CAP + 1) }]) {
        const res = await new Client().post('/auth/code/request', body);
        expect(res.status, JSON.stringify(body).slice(0, 40)).to.eq(400);
        expect((res.body as { error?: string }).error).to.eq('invalid_login');
      }
      expect(fake.calls).to.deep.eq([]);
    });

    it('an unknown field answers 400 invalid_field (D5) and never reaches the service', async () => {
      const res = await new Client().post('/auth/code/request', { login: 'someone@example.test', remember: true });
      expect(res.status).to.eq(400);
      expect((res.body as { error?: string }).error).to.eq('invalid_field');
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(fake.calls).to.deep.eq([]);
    });
  });

  describe('POST /auth/code/login', () => {
    it('logs in with the code: the session cookie, the principal summary with method email-code and the login extensions', async () => {
      const u = await seedUser();
      const c = new Client();
      const res = await c.post('/auth/code/login', { login: u.login, code: KIT_CODE });
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      const body = res.body as { Identity: unknown; Authn: Record<string, unknown> };
      expect(body.Identity).to.deep.eq({ type: 'user', id: u.ref.id });
      expect(body.Authn).to.include({ method: 'email-code', strategy: 'email-code', assurance: 'aal1' });
      expect(V3AppResponseExtension.calls.map((x) => x.kind)).to.deep.eq(['login']);
      expect(res.headers['cache-control']).to.eq('no-store');
      expect((await probe(c)).principal.id).to.eq(u.ref.id);
    });

    it('answers the one failure body for a wrong code, an unknown login and a banned account', async () => {
      const u = await seedUser();
      const banned = await seedUser();
      identities.setStatus(banned.ref, { banned: true });
      for (const body of [
        { login: u.login, code: '000000' },
        { login: 'nobody@example.test', code: KIT_CODE },
        { login: banned.login, code: KIT_CODE },
      ]) {
        const res = await new Client().post('/auth/code/login', body);
        expect(res.status, JSON.stringify(body)).to.eq(401);
        expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
        expect(res.headers['retry-after']).to.eq(undefined);
      }
    });

    it('a missing, non-string or over-long field answers the failure body without reaching the strategy', async () => {
      const u = await seedUser();
      for (const body of [{}, { login: u.login }, { code: KIT_CODE }, { login: u.login, code: 123456 }, { login: u.login, code: 'x'.repeat(PASSWORD_HARD_CAP + 1) }, { login: u.login, code: KIT_CODE, extra: 1 }]) {
        const res = await new Client().post('/auth/code/login', body);
        expect(res.status).to.eq(401);
        expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
      }
    });
  });
}
