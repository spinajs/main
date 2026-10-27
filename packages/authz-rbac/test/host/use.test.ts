import * as chai from 'chai';
import 'mocha';
import { AuthorizationModel, AuthzClock, AuthzContributor, LinkResolver, resolveUsedModels } from '@spinajs/authz';
import { ManualClock, testHost } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { RbacContributor, RbacModel, RbacOptions, RbacService } from '../../src/index.js';
import type { RbacExtension, RegisterRbacOptions } from '../../src/index.js';

const expect = chai.expect;
const KEY = 'authz.use';
const WHERE = 'Authz domain "root"';

describe('authz-rbac under authz.use', () => {
  let container: IContainer;

  beforeEach(() => {
    container = DI.child();
    container.register(testHost.instance(new testHost.TestConfiguration())).as(Configuration);
  });

  afterEach(async () => {
    await container.dispose();
  });

  it('registers itself as "rbac": the model, its contributor, RbacService and the LinkResolver of the resolving container', async () => {
    const [model] = await resolveUsedModels(container, ['rbac'], KEY, WHERE);
    expect(model).to.be.instanceOf(RbacModel);
    expect(await container.resolve(AuthzContributor)).to.be.instanceOf(RbacContributor);
    expect(((await container.resolve(RbacService)) as RbacService).model).to.equal(model);
    expect(container.hasRegistered(LinkResolver, false)).to.equal(true);
  });

  it('leaves AuthorizationModel to the host: the use list activates it', async () => {
    await resolveUsedModels(container, ['rbac'], KEY, WHERE);
    expect(container.hasRegistered(AuthorizationModel, false)).to.equal(false);
  });

  it('times its caches with the AuthzClock of the resolving container', async () => {
    const clock = new ManualClock(new Date('2026-10-01T00:00:00.000Z'));
    container.register(testHost.instance(clock)).as(AuthzClock);
    const [model] = await resolveUsedModels(container, ['rbac'], KEY, WHERE);
    expect((model as RbacModel).currentTime()).to.deep.equal(clock.now());
  });

  it('takes the options of a registered RbacOptions over the defaults', async () => {
    const marker: RbacExtension = {};
    class Custom extends RbacOptions {
      options(): RegisterRbacOptions {
        return { extensions: () => [marker] };
      }
    }
    container.register(Custom).as(RbacOptions);
    const [model] = await resolveUsedModels(container, ['rbac'], KEY, WHERE);
    expect((model as RbacModel).extensions).to.include(marker);
  });
});
