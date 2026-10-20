import 'mocha';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { AuthzConfigError } from '@spinajs/authz';
import { RoleStore } from '@spinajs/authz-rbac';

import { configuredRoleNames } from '../../src/services/user-roles.js';

chai.use(chaiAsPromised);

describe('users-http v3: role definitions', () => {
  afterEach(() => {
    sinon.restore();
  });

  // The account guard counts witnesses per role and GET /users/roles offers them: a raw root read of
  // authz.rbac.roles would answer with roles the RBAC model does not use.
  it('come from the RoleStore only: without one they fail as a configuration error', async () => {
    const hasRegistered = DI.RootContainer.hasRegistered.bind(DI.RootContainer);
    sinon.stub(DI.RootContainer, 'hasRegistered').callsFake(((service: unknown) => (service === RoleStore ? false : hasRegistered(service as never))) as never);

    await expect(configuredRoleNames()).to.be.rejectedWith(AuthzConfigError, /RoleStore/);
  });
});
