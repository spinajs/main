import 'mocha';
import { expect } from 'chai';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, explicitAppEnv } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';
import { configurationOf, NoSource } from './fixtures.js';

describe('configuration app env', () => {
  const saved = { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
  const containers: IContainer[] = [];

  const setEnv = (APP_ENV?: string, NODE_ENV?: string) => {
    for (const [k, v] of Object.entries({ APP_ENV, NODE_ENV })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  const load = async (options: { values?: Record<string, unknown>; registered?: NodeJS.ProcessEnv; env?: string } = {}) => {
    const c = DI.RootContainer.child();
    containers.push(c);
    c.register(NoSource).as(ConfigurationSource);
    if (options.registered) c.register(options.registered).asValue('process.env');
    c.register(configurationOf(options.values ?? {})).as(Configuration);
    const config = (await c.resolve(Configuration)) as FrameworkConfiguration;
    if (options.env !== undefined) {
      config.Env = options.env;
      await config.load();
    }
    return config;
  };

  beforeEach(() => setEnv(undefined, undefined));

  afterEach(async () => {
    setEnv(saved.APP_ENV, saved.NODE_ENV);
    for (const c of containers.splice(0).reverse()) await c.dispose();
  });

  it('records a fallback to development as no named env', async () => {
    const config = await load();
    expect(config.get('process.env.APP_ENV')).to.equal('development');
    expect(config.NamedEnv).to.equal(undefined);
    expect(explicitAppEnv(config)).to.equal(undefined);
  });

  it('records the env of --env, the registered process.env, then NODE_ENV', async () => {
    setEnv(undefined, 'development');
    expect((await load()).NamedEnv).to.equal('development');
    expect(explicitAppEnv(await load())).to.equal('development');
    expect((await load({ registered: { APP_ENV: 'test' } })).NamedEnv).to.equal('test');
    expect((await load({ registered: { APP_ENV: 'test' }, env: 'staging' })).NamedEnv).to.equal('staging');
  });

  it('does not take a development set only by a config file as named', async () => {
    setEnv(undefined, 'staging');
    const config = await load({ values: { process: { env: { APP_ENV: 'development' } } } });
    expect(config.get('process.env.APP_ENV')).to.equal('development');
    expect(explicitAppEnv(config)).to.equal(undefined);
  });
});
