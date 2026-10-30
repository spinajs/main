import 'mocha';
import { expect } from 'chai';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, FrameworkConfiguration, IConfigLike, InvalidConfiguration } from '@spinajs/configuration';
import { INTL_CONFIGURATION_SCHEMA } from '../src/schemas/intl.configuration.js';
import shipped from '../src/config/locales.js';

class NoSource extends ConfigurationSource {
  public get Order() {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({} as IConfigLike);
  }
}

describe('intl configuration schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function violationsOf(config: unknown): Promise<string[]> {
    const child = DI.child();
    children.push(child);
    child.register(INTL_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
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

  it('accepts the shipped config and a custom set of locales', async () => {
    expect(await violationsOf(shipped)).to.deep.equal([]);
    expect(await violationsOf({ intl: { defaultLocale: 'pl', locales: ['pl', 'en'], queryParameter: 'language' } })).to.deep.equal([]);
  });

  it('refuses locales that are not a list of names and an empty default locale', async () => {
    expect(await violationsOf({ intl: { locales: 'pl' } })).to.deep.equal(['intl.locales']);
    expect(await violationsOf({ intl: { defaultLocale: '' } })).to.deep.equal(['intl.defaultLocale']);
    expect(await violationsOf({ intl: { queryParameter: null } })).to.deep.equal(['intl.queryParameter']);
  });
});
