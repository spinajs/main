import * as chai from 'chai';
import 'mocha';
import { AuthzContributor, resolveUsedModels } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AbacContributor, AbacModel } from '../src/index.js';

const expect = chai.expect;

describe('authz-abac under authz.use', () => {
  let container: IContainer;

  beforeEach(() => {
    container = DI.child();
  });

  afterEach(async () => {
    await container.dispose();
  });

  it('registers itself as "abac", with its contributor on the resolving container', async () => {
    const [model] = await resolveUsedModels(container, ['abac'], 'authz.use', 'Authz domain "root"');
    expect(model).to.be.instanceOf(AbacModel);
    expect(model.name).to.equal('abac');
    expect(await container.resolve(AuthzContributor)).to.be.instanceOf(AbacContributor);
  });
});
