import 'mocha';
import { expect } from 'chai';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { NoSource } from './fixtures.js';
import { FrameworkConfiguration } from '../src/configuration.js';

const LIMITS = {
  $id: 'test-added-limits',
  $configurationModule: 'limits',
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' }, min: { type: 'number' }, max: { type: 'number', maximum: 25, minimum: { $data: '1/min' } } },
};

describe('violations a change would add', () => {
  let child: IContainer;
  let config: FrameworkConfiguration;

  before(async () => {
    child = DI.child();
    child.register(LIMITS).asValue('__configurationSchema__');
    child.register(NoSource).as(ConfigurationSource);
    child
      .register(
        class extends FrameworkConfiguration {
          protected loadSources(): void {
            this.Sources = [];
          }

          protected onLoad(): unknown {
            return { limits: { name: 'a', max: 20 } };
          }
        },
      )
      .as(Configuration);
    config = (await child.resolve(Configuration)) as FrameworkConfiguration;
  });

  after(async () => {
    await child.dispose();
  });

  it('names the violation of a refused value and changes nothing', () => {
    expect(config.violationsAdded('limits.max', 30)).to.deep.equal([{ path: 'limits.max', schema: 'test-added-limits', message: 'must be <= 25' }]);
    expect(config.get('limits.max')).to.equal(20);
  });

  it('reports nothing for an accepted value, or a path no schema covers', () => {
    expect(config.violationsAdded('limits.max', 25)).to.be.empty;
    expect(config.violationsAdded('elsewhere.max', 99)).to.be.empty;
  });

  it('checks the value over the tree merged with `over`', () => {
    expect(config.violationsAdded('limits.min', 22)).to.deep.equal([{ path: 'limits.max', schema: 'test-added-limits', message: 'must be >= 22' }]);
    expect(config.violationsAdded('limits.min', 22, { limits: { max: 24 } })).to.be.empty;
  });

  it('does not report a violation the tree already had', () => {
    expect(config.violationsAdded('limits.min', 1, { limits: { name: { first: 'a' } } })).to.be.empty;
    expect(config.violationsAdded('limits.max', 30, { limits: { name: { first: 'a' } } })).to.have.length(1);
  });
});
