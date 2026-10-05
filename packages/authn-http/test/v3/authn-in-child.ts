import sinon from 'sinon';
import type { IContainer } from '@spinajs/di';

import { AuthnMiddleware } from '../../src/middleware/authn.js';

/**
 * Until the returned stub is restored, the registered AuthnMiddleware resolves its session issuer, extractors and
 * resolvers from `child`, where a suite keeps its kit fakes. The suite uncaches AuthnMiddleware before its server
 * starts and after it stops, so no other suite gets this instance.
 */
export function buildAuthnMiddlewareIn(child: IContainer): sinon.SinonStub {
  const resolve = AuthnMiddleware.prototype.resolve;
  return sinon.stub(AuthnMiddleware.prototype, 'resolve').callsFake(async function (this: AuthnMiddleware) {
    (this as unknown as { Container: IContainer }).Container = child;
    return resolve.call(this);
  });
}
