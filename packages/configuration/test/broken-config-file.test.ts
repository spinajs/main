import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { join, normalize } from 'path';
import { DI } from '@spinajs/di';

import { InvalidConfiguration } from '../src/exception.js';
import { FrameworkConfiguration } from '../src/configuration.js';

chai.use(chaiAsPromised);

const fixtures = normalize(join(process.cwd(), 'test', 'broken-config'));

// By class, not by the Configuration token: other suites register their own configuration under it.
function resolveWith(dir: string) {
  return DI.resolve(FrameworkConfiguration, [{ cfgCustomPaths: [join(fixtures, dir)] }]);
}

describe('a config file that cannot be loaded', function () {
  // The resolve also loads the config of every installed @spinajs package.
  this.timeout(15000);

  beforeEach(() => {
    DI.clearCache();
    DI.setESMModuleSupport();
  });

  // The file sources are singletons that keep the broken directory in their search list.
  afterEach(() => DI.clearCache());

  it('fails the resolve when a JS module throws on import, naming the file', async () => {
    const file = join(fixtures, 'js', 'broken.cjs');

    const error = (await expect(resolveWith('js')).to.be.rejectedWith(InvalidConfiguration)) as InvalidConfiguration;

    expect(error.message).to.contain(file);
    expect(error.message).to.contain('this config module is broken');
    expect((error.cause as Error).message).to.equal('this config module is broken');
  });

  it('fails the resolve when a JSON file has a syntax error, naming the file', async () => {
    const file = join(fixtures, 'json', 'broken.json');

    const error = (await expect(resolveWith('json')).to.be.rejectedWith(InvalidConfiguration)) as InvalidConfiguration;

    expect(error.message).to.contain(file);
    expect(error.cause).to.be.instanceOf(SyntaxError);
  });
});
