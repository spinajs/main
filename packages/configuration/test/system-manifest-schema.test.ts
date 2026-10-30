import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { configurationOf, NoSource } from './fixtures.js';
import { InvalidConfiguration } from '../src/exception.js';
import { SYSTEM_CONFIGURATION_SCHEMA } from '../src/schemas/system.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const booted: IContainer[] = [];

async function boot(values: Record<string, unknown>): Promise<Configuration> {
  const child = DI.child();
  booted.push(child);
  child.register(SYSTEM_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  child.register(NoSource).as(ConfigurationSource);
  child.register(configurationOf(values)).as(Configuration);
  return child.resolve(Configuration);
}

describe('system.manifest schema', () => {
  afterEach(async () => {
    for (const c of booted.splice(0).reverse()) await c.dispose();
  });

  it('defaults mode to off and path to app.manifest.json', async () => {
    const config = await boot({ system: {} });
    expect(config.get('system.manifest')).to.deep.equal({ path: 'app.manifest.json', mode: 'off' });
  });

  it('accepts every documented mode', async () => {
    for (const mode of ['off', 'prefer', 'require']) {
      const config = await boot({ system: { manifest: { mode } } });
      expect(config.get('system.manifest.mode')).to.equal(mode);
    }
  });

  it('refuses an unknown mode', async () => {
    await expect(boot({ system: { manifest: { mode: 'always' } } })).to.be.rejectedWith(InvalidConfiguration, /system\.manifest\.mode/);
  });

  it('drops an unknown manifest key (the validator runs with removeAdditional)', async () => {
    const config = await boot({ system: { manifest: { pth: 'x' } } });
    expect(config.get('system.manifest')).to.deep.equal({ path: 'app.manifest.json', mode: 'off' });
  });

  it('keeps system keys and system.dirs entries it does not know', async () => {
    const config = await boot({ system: { custom: 1, dirs: { anything: ['/x'] } } });
    expect(config.get<string[]>('system.dirs.anything')).to.include('/x');
    expect(config.get('system.custom')).to.equal(1);
  });
});
