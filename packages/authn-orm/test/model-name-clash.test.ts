import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';

import { AuthnAudit, AuthnNonceModel, AuthnThrottle } from '../src/index.js';

// DI keys classes by name and drops a second class of the same name under one key. authn-keys has
// its own `AuthnNonce` model on the same table and the authn package has `AuthnAudit` and
// `AuthnThrottle` services, so the models here must not share those names where they collide.
describe('authn-orm model names', () => {
  it('does not name the nonce model like the authn-keys model', () => {
    expect(AuthnNonceModel.name).to.not.eq('AuthnNonce');
  });

  it('lists its models, including the ones named like authn services', () => {
    const models = DI.getRegisteredTypes<unknown>('__models__');
    expect(models).to.include.members([AuthnNonceModel, AuthnAudit, AuthnThrottle]);
  });
});
