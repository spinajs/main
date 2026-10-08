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
      await registerAuthnHttpV3(child);
      expect(count()).to.deep.eq({ middlewares: 1, extractors: 3, resolvers: 3 });
      await registerAuthnHttpV3(child);
      expect(count()).to.deep.eq({ middlewares: 1, extractors: 3, resolvers: 3 });
    } finally {
      await child.dispose();
    }
  });
});
