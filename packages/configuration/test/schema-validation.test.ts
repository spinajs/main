import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';
import { InvalidConfiguration } from '../src/exception.js';
import { registerConfigurationSchema } from '../src/schemas.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

function configurationOf(values: Record<string, unknown>) {
  const json = JSON.stringify(values);
  return class extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  };
}

const WITH_DEFAULTS = {
  $id: 'test-with-defaults',
  $configurationModule: 'withDefaults',
  type: 'object',
  properties: { timeoutMs: { type: 'integer', minimum: 1, default: 2000 } },
};

const REQUIRES_HOST = {
  $id: 'test-requires-host',
  $configurationModule: 'requiresHost',
  type: 'object',
  required: ['host'],
  properties: { host: { type: 'string' } },
};

const RANGE = {
  $id: 'test-range',
  $configurationModule: 'range',
  type: 'object',
  properties: {
    min: { type: 'integer' },
    max: { type: 'integer', minimum: { $data: '1/min' } },
  },
};

class NoSource extends ConfigurationSource {
  public get Order() {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({} as IConfigLike);
  }
}

async function boot(values: Record<string, unknown>, ...schemas: object[]) {
  const child = DI.child();
  for (const s of schemas) child.register(s).asValue('__configurationSchema__');
  child.register(NoSource).as(ConfigurationSource);
  child.register(configurationOf(values)).as(Configuration);
  return { child, config: await child.resolve(Configuration) };
}

describe('configuration schema validation', () => {
  beforeEach(() => DI.clear());

  it('applies the defaults of a module that is not configured at all', async () => {
    const { config } = await boot({}, WITH_DEFAULTS);
    expect(config.get('withDefaults.timeoutMs')).to.equal(2000);
  });

  it('leaves an unconfigured module alone when its schema needs values', async () => {
    const { config } = await boot({}, REQUIRES_HOST);
    expect(config.get('requiresHost')).to.equal(undefined);
  });

  it('validates with the schemas of every ancestor, not only the nearest container', async () => {
    DI.register(WITH_DEFAULTS).asValue('__configurationSchema__');
    await expect(boot({ requiresHost: { host: 'h' }, withDefaults: { timeoutMs: 0 } }, REQUIRES_HOST)).to.be.rejectedWith(InvalidConfiguration);
  });

  it('names the full path, the schema and the message of every bad value', async () => {
    let error: unknown;
    try {
      await boot({ withDefaults: { timeoutMs: 0 } }, WITH_DEFAULTS);
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidConfiguration);
    const [v] = (error as InvalidConfiguration).violations;
    expect(v).to.deep.include({ path: 'withDefaults.timeoutMs', schema: 'test-with-defaults' });
    expect(v.message).to.be.a('string').and.not.equal('');
    expect((error as Error).message).to.contain('withDefaults.timeoutMs').and.contain('test-with-defaults');
  });

  it('supports $data references between fields', async () => {
    await expect(boot({ range: { min: 10, max: 5 } }, RANGE)).to.be.rejectedWith(InvalidConfiguration);
    const { config } = await boot({ range: { min: 5, max: 10 } }, RANGE);
    expect(config.get('range.max')).to.equal(10);
  });

  it('validates and defaults a module whose schema is registered after the Configuration resolved', async () => {
    const { child, config } = await boot({});
    registerConfigurationSchema(WITH_DEFAULTS, child);
    expect(config.get('withDefaults.timeoutMs')).to.equal(2000);
  });

  it('fails at registration when the already loaded module violates the late schema', async () => {
    const { child } = await boot({ range: { min: 10, max: 5 } });
    expect(() => registerConfigurationSchema(RANGE, child)).to.throw(InvalidConfiguration);
  });
});
