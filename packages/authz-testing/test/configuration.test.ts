import 'mocha';
import { expect } from 'chai';
import { Config } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { bindConfiguration, bootConfiguration, violationPaths } from '../src/index.js';

const SCHEMA = {
  $id: 'spinajs/authz-testing.probe.schema.json',
  $configurationModule: 'probe',
  type: 'object',
  properties: {
    size: { type: 'integer', minimum: 1, default: 3 },
    name: { type: 'string', minLength: 1 },
  },
};

class Probe {
  @Config('probe.size')
  public Size: number;
}

describe('authz-testing configuration helpers', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  it('bootConfiguration validates the values with the schemas and fills their defaults', async () => {
    const { child, configuration } = await bootConfiguration({ probe: { name: 'a' } }, [SCHEMA]);
    children.push(child);

    expect(configuration.get('probe')).to.deep.equal({ name: 'a', size: 3 });
  });

  it('violationPaths gives the full path of every refused value', async () => {
    expect(await violationPaths(bootConfiguration({ probe: { size: 0, name: '' } }, [SCHEMA]))).to.include.members(['probe.size', 'probe.name']);
  });

  it('violationPaths fails when the boot succeeds', async () => {
    const error = await violationPaths(bootConfiguration({ probe: {} }, [SCHEMA])).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).to.be.instanceOf(Error).with.property('message').that.contains('booted');
  });

  it('bindConfiguration points the @Config properties of an instance built with new at a container', async () => {
    const { child } = await bootConfiguration({ probe: { size: 7 } }, [SCHEMA]);
    children.push(child);

    expect(bindConfiguration(new Probe(), child).Size).to.equal(7);
  });
});
