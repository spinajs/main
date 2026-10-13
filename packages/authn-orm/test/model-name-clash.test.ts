import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';

import { AuthnAudit, AuthnThrottle } from '../src/index.js';

// DI keys classes by name and drops a second class of the same name under one key. The authn package has
// `AuthnAudit` and `AuthnThrottle` services, so these models must still register under their own names.
describe('authn-orm model names', () => {
  it('lists its models, including the ones named like authn services', () => {
    const models = DI.getRegisteredTypes<unknown>('__models__');
    expect(models).to.include.members([AuthnAudit, AuthnThrottle]);
  });
});
