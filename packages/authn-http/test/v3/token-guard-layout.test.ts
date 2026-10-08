import 'mocha';
import { expect } from 'chai';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';

import { AuthnTokensController } from '../../src/v3/controllers/AuthnTokensController.js';
import { TokenServiceRegistered } from '../../src/token/gate.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '../../src/v3/index.js';

/** The 3.0 form of LEDGER token-controller 10: guards sit in one mandatory group, on every route. */
describe('AuthnTokensController guard layout (token-controller 10, token-controller-roles 2, 3, 5, 6, 7)', () => {
  // Stored on the prototype: the Controller() decorator writes to target.prototype.
  const descriptor = (): IControllerDescriptor => Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AuthnTokensController.prototype);

  it('the controller scope holds one group: the TokenService gate', () => {
    const groups = descriptor().Policies;
    expect(groups, 'a second controller group would be ORed with the first').to.have.length(1);
    expect(groups[0].map((p) => p.Type)).to.deep.eq([TokenServiceRegistered]);
  });

  it('serves list, create and revoke, and nothing that edits a token role', () => {
    expect([...descriptor().Routes.keys()].sort()).to.deep.eq(['create', 'list', 'revoke']);
  });

  it('each route carries exactly one group with Authenticated, NoTokenAuthPolicy and NoImpersonationPolicy together', () => {
    for (const [name, route] of descriptor().Routes) {
      // A second @Policy() on the route would be ORed with this group and make each member optional.
      expect(route.Policies, `route ${String(name)}: one group`).to.have.length(1);
      expect(
        route.Policies[0].map((p) => p.Type),
        `route ${String(name)}`,
      ).to.have.members([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy]);
    }
  });
});
