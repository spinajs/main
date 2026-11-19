import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { join, normalize } from 'path';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';
import { InvalidConfiguration } from '../src/exception.js';

chai.use(chaiAsPromised);

const fixtures = normalize(join(process.cwd(), 'test', 'strict-keys-config'));

const STRICT_KEYS = {
  $id: 'test-strict-keys',
  $configurationModule: 'strictKeys',
  type: 'object',
  propertyNames: { enum: ['host', 'port'] },
};

async function load(dir: string) {
  const child = DI.child();
  child.register(STRICT_KEYS).asValue('__configurationSchema__');
  child.register(class extends FrameworkConfiguration {}).as(Configuration);
  return child.resolve(Configuration, [{ cfgCustomPaths: [join(fixtures, dir)] }]);
}

describe('a module loaded from a config file under a schema that refuses unknown keys', function () {
  // The resolve also loads the config of every installed @spinajs package.
  this.timeout(15000);

  beforeEach(() => {
    DI.clearCache();
    DI.setESMModuleSupport();
  });

  // The file sources are singletons that keep the fixture directory in their search list.
  afterEach(() => DI.clearCache());

  it('passes when it comes from a JS file and holds only the keys of the file', async () => {
    const config = await load('js');

    expect(config.get('strictKeys')).to.deep.equal({ host: 'js-host', port: 1 });
  });

  it('passes when it comes from a JSON file and holds only the keys of the file', async () => {
    const config = await load('json');

    expect(config.get('strictKeys')).to.deep.equal({ host: 'json-host', port: 2 });
  });

  it('still fails the boot on a key the file sets and the schema does not allow', async () => {
    const error = (await expect(load('unknown-key')).to.be.rejectedWith(InvalidConfiguration)) as InvalidConfiguration;

    expect(error.violations.map((v) => v.path)).to.deep.equal(['strictKeys.prot']);
  });
});
