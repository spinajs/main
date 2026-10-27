import * as chai from 'chai';
import 'mocha';
import { AuthorizationModel, AuthzClock, PermissionRegistryImpl, resolveListedModels } from '@spinajs/authz';
import { ManualClock, fakeModelInitContext, testHost } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { RbacModel, RbacOptions } from '../../src/index.js';
import type { RbacExtension, RegisterRbacOptions } from '../../src/index.js';

const expect = chai.expect;
const KEY = 'authz.models';
const WHERE = 'Authz domain "root"';

function registry(): PermissionRegistryImpl {
  const reg = new PermissionRegistryImpl();
  reg.freeze();
  return reg;
}

describe('RbacModel under authz.models', () => {
  let container: IContainer;

  beforeEach(() => {
    container = DI.child();
    container.register(testHost.instance(new testHost.TestConfiguration())).as(Configuration);
  });

  afterEach(async () => {
    await container.dispose();
  });

  /** As a domain's boot: the listed class resolved in `container`, then initialised with it. */
  async function listed(): Promise<RbacModel> {
    const [model] = await resolveListedModels(container, ['RbacModel'], KEY, WHERE);
    await model.init(fakeModelInitContext({ model: 'rbac', container, permissions: registry() }));
    return model as RbacModel;
  }

  it('is listed by its class name and is an RbacModel', async () => {
    expect(await listed()).to.be.instanceOf(RbacModel);
  });

  it('registers nothing under AuthorizationModel in the domain: the models list activates it', async () => {
    await listed();
    expect(container.hasRegistered(AuthorizationModel, false)).to.equal(false);
  });

  it('times its caches with the AuthzClock of its domain container', async () => {
    const clock = new ManualClock(new Date('2026-10-01T00:00:00.000Z'));
    container.register(testHost.instance(clock)).as(AuthzClock);
    expect((await listed()).currentTime()).to.deep.equal(clock.now());
  });

  it('takes the options of a registered RbacOptions', async () => {
    const marker: RbacExtension = {};
    class Custom extends RbacOptions {
      options(): RegisterRbacOptions {
        return { extensions: () => [marker] };
      }
    }
    container.register(Custom).as(RbacOptions);
    expect((await listed()).extensions).to.include(marker);
  });
});
