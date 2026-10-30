import 'mocha';
import { expect } from 'chai';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, FrameworkConfiguration, IConfigLike, InvalidConfiguration } from '@spinajs/configuration';
import { TEMPLATES_CONFIGURATION_SCHEMA } from '../src/schemas/templates.configuration.js';
import shipped from '../src/config/templates.js';

class NoSource extends ConfigurationSource {
  public get Order() {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({} as IConfigLike);
  }
}

describe('templates configuration schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function violationsOf(config: unknown): Promise<string[]> {
    const child = DI.child();
    children.push(child);
    child.register(TEMPLATES_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
    child.register(NoSource).as(ConfigurationSource);
    child
      .register(
        class extends FrameworkConfiguration {
          protected loadSources(): void {
            this.Sources = [];
          }

          protected onLoad(): unknown {
            return config;
          }
        },
      )
      .as(Configuration);
    try {
      await child.resolve(Configuration);
      return [];
    } catch (e) {
      if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
      throw e;
    }
  }

  it('accepts the shipped config, a cache mode and the sections of the renderer packages', async () => {
    expect(await violationsOf(shipped)).to.deep.equal([]);
    expect(await violationsOf({ templates: { cache: { mode: 'revalidate' }, pug: { basedir: '/x' } } })).to.deep.equal([]);
  });

  it('refuses an unknown cache mode and a cache that is not an object', async () => {
    expect(await violationsOf({ templates: { cache: { mode: 'forever' } } })).to.deep.equal(['templates.cache.mode']);
    expect(await violationsOf({ templates: { cache: 'cache' } })).to.deep.equal(['templates.cache']);
  });
});
