import * as chai from 'chai';
import 'mocha';
import { AuthzContributor, PermissionRegistryImpl, resolveListedModels } from '@spinajs/authz';
import { fakeModelInitContext } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AbacContributor, AbacModel } from '../src/index.js';

const expect = chai.expect;

describe('AbacModel under authz.models', () => {
  let container: IContainer;

  beforeEach(() => {
    container = DI.child();
  });

  afterEach(async () => {
    await container.dispose();
  });

  it('is listed by its class name, one instance per container, and its init registers its contributor there', async () => {
    const [model] = await resolveListedModels(container, ['AbacModel'], 'authz.models', 'Authz domain "root"');
    expect(model).to.be.instanceOf(AbacModel);
    expect(model.name).to.equal('abac');
    const other = DI.child();
    try {
      expect(await other.resolve(AbacModel)).to.not.equal(model);
    } finally {
      await other.dispose();
    }

    const registry = new PermissionRegistryImpl();
    registry.freeze();
    await model.init(fakeModelInitContext({ model: 'abac', container, permissions: registry, config: { stores: ['ConfigPolicyStore'] } }));
    expect(await container.resolve(AuthzContributor)).to.be.instanceOf(AbacContributor);
  });
});
