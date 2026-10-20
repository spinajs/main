import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { testHost, userPrincipal } from '@spinajs/authz-testing';

import { ANONYMOUS, HasPrincipal, PrincipalSource, accessEpoch } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';

const authn = (sessionHandle: string) => ({ method: 'password', strategy: 'local', assurance: 'aal1' as const, mfa: [], authenticatedAt: new Date(0), sessionHandle });

/** `x-user` names the user, `x-session` its session handle, `x-ceiling` one ceiling permission. */
class EpochHeaderSource extends PrincipalSource {
  public readonly name = 'test-epoch';
  public readonly order = 0;

  public async authenticate(req: Request): Promise<Principal | null> {
    const id = req.headers['x-user'];
    if (typeof id !== 'string' || id === '') return null;
    const session = req.headers['x-session'];
    const ceiling = req.headers['x-ceiling'];
    return userPrincipal(id, { ...(typeof session === 'string' ? { authn: authn(session) } : {}), ...(typeof ceiling === 'string' ? { ceiling: { permissions: [ceiling] } } : {}) });
  }
}

@BasePath('epoch')
class EpochProbeController extends BaseController {
  @Get('/')
  @Policy(HasPrincipal)
  public probe() {
    return new Ok({ ok: true });
  }
}

describe('X-Access-Epoch', function () {
  this.timeout(30000);

  describe('accessEpoch', () => {
    it('is 16 hex characters, stable for one principal', () => {
      const epoch = accessEpoch(userPrincipal('alice', { authn: authn('s1') }));
      expect(epoch).to.match(/^[0-9a-f]{16}$/);
      expect(accessEpoch(userPrincipal('alice', { authn: authn('s1') }))).to.eq(epoch);
    });

    it('changes with the principal, the session handle and the ceiling', () => {
      const base = accessEpoch(userPrincipal('alice', { authn: authn('s1') }));
      expect(accessEpoch(userPrincipal('bob', { authn: authn('s1') }))).to.not.eq(base);
      expect(accessEpoch(userPrincipal('alice', { authn: authn('s2') }))).to.not.eq(base);
      expect(accessEpoch(userPrincipal('alice', { authn: authn('s1'), ceiling: { permissions: ['file:read'] } }))).to.not.eq(base);
    });
  });

  describe('on responses', () => {
    let app: TestApp;

    before(async () => {
      DI.register(EpochHeaderSource).as(PrincipalSource);
      app = await startApp({ controllers: [EpochProbeController] });
    });

    after(async () => {
      await stopApp();
      DI.unregister(EpochHeaderSource);
      DI.uncache(EpochHeaderSource);
      DI.uncache(PrincipalSource);
    });

    it("carries the epoch of the request's principal", async () => {
      const res = await app.request().get('/epoch').set('x-user', 'alice').set('x-session', 's1');

      expect(res.status).to.eq(200);
      expect(res.header['x-access-epoch']).to.eq(accessEpoch(userPrincipal('alice', { authn: authn('s1') })));
    });

    it('changes when the session rotates or the ceiling changes, not otherwise', async () => {
      const epoch = async (headers: Record<string, string>) => {
        let r = app.request().get('/epoch');
        for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
        return (await r).header['x-access-epoch'] as string;
      };

      const first = await epoch({ 'x-user': 'alice', 'x-session': 's1' });
      expect(await epoch({ 'x-user': 'alice', 'x-session': 's1' })).to.eq(first);
      expect(await epoch({ 'x-user': 'alice', 'x-session': 's2' })).to.not.eq(first);
      expect(await epoch({ 'x-user': 'alice', 'x-session': 's1', 'x-ceiling': 'file:read' })).to.not.eq(first);
    });

    it('gives the anonymous principal its epoch and leaves a request without a principal without one', async () => {
      const anonymous = await app.request().get('/epoch');
      expect(anonymous.header['x-access-epoch']).to.eq(accessEpoch(ANONYMOUS));

      testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], false);
      try {
        const none = await app.request().get('/epoch');
        expect(none.status).to.eq(401);
        expect(none.header).to.not.have.property('x-access-epoch');
      } finally {
        testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], true);
      }
    });
  });
});
