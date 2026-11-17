import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';

import { AuthnThrottle } from '../src/index.js';

// DI keys classes by name and drops a second class of the same name under one key. The authn package has an
// `AuthnThrottle` service, so this model must still register under its own name.
describe('authn-orm model names', () => {
  it('lists its models, including the one named like an authn service', () => {
    const models = DI.getRegisteredTypes<unknown>('__models__');
    expect(models).to.include.members([AuthnThrottle]);
  });
});
