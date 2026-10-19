import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ServerMiddleware } from '@spinajs/http';
import { CredentialExtractor } from '@spinajs/authn/contracts';

import { AuthnPrincipalResolver } from '../../src/api.js';
import { registerAuthnHttpV3 } from '../../src/v3/register.js';

describe('registerAuthnHttpV3', () => {
  it('a second call on the same container registers nothing twice (task 3 review R3)', async () => {
    const child = DI.RootContainer.child();
    try {
      const count = () => ({
        middlewares: (child.getRegisteredTypes(ServerMiddleware, false) ?? []).filter((t) => t.name === 'AuthnMiddleware').length,
        extractors: (child.getRegisteredTypes(CredentialExtractor, false) ?? []).length,
        resolvers: (child.getRegisteredTypes(AuthnPrincipalResolver, false) ?? []).length,
      });
      registerAuthnHttpV3(child);
      expect(count()).to.deep.eq({ middlewares: 1, extractors: 3, resolvers: 3 });
      registerAuthnHttpV3(child);
      expect(count()).to.deep.eq({ middlewares: 1, extractors: 3, resolvers: 3 });
    } finally {
      await child.dispose();
    }
  });

  it('registers every middleware and route arg in the container it is given, synchronously', async () => {
    const child = DI.RootContainer.child();
    try {
      expect(registerAuthnHttpV3(child)).to.eq(undefined);
      expect((child.getRegisteredTypes(ServerMiddleware, false) ?? []).map((t) => t.name)).to.include.members(['ClientIp', 'CsrfOriginGuard', 'AuthnMiddleware']);
      for (const arg of ['AuthnIdentityArg', 'AuthnSessionArg', 'AuthnSessionIdArg', 'AuthnSessionDataArg']) expect(child.hasRegistered(arg, false), arg).to.eq(true);
    } finally {
      await child.dispose();
    }
  });
});
