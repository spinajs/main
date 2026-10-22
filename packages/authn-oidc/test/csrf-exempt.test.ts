import 'mocha';
import { expect } from 'chai';
import { CsrfGuard, isCsrfExempt } from '@spinajs/http';
import type { BaseController } from '@spinajs/http';

import { OidcController } from '../src/controllers/OidcController.js';
import { fakeContainer, readingFrom } from './support/config-boot.js';

const EVIL = 'https://evil.example.net';

class MountedGuard extends CsrfGuard {
  protected controllers(): readonly BaseController[] {
    return [Object.create(OidcController.prototype) as OidcController];
  }
}

function post(path: string, method = 'POST'): number {
  const guard = readingFrom(new MountedGuard(), fakeContainer({ 'http.controllers.route.prefix': '' }));
  Object.defineProperty(guard, 'Log', { value: { debug: () => undefined } });
  let status = 200;
  const res = { status: (c: number) => ((status = c), res), json: () => res };
  const req = { method, path, url: path, headers: { host: 'app.example.test', origin: EVIL }, socket: { remoteAddress: '127.0.0.1' }, storage: {} };
  guard.before()!(req as never, res as never, () => undefined);
  return status;
}

describe('OIDC routes and the CSRF guard (X3)', () => {
  it('back-channel logout is @CsrfExempt: the IdP posts it server to server', () => {
    expect(isCsrfExempt(OidcController.prototype, 'backchannelLogout')).to.eq(true);
    expect(post('/auth/oidc/keycloak/backchannel-logout')).to.eq(200);
  });

  it('the link routes stay checked', () => {
    expect(isCsrfExempt(OidcController.prototype, 'beginLink')).to.eq(false);
    expect(post('/auth/oidc/keycloak/link')).to.eq(403);
    expect(post('/auth/oidc/keycloak/link', 'DELETE')).to.eq(403);
  });
});
