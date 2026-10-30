import 'mocha';
import { expect } from 'chai';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, FrameworkConfiguration, IConfigLike, InvalidConfiguration } from '@spinajs/configuration';
import { HTTPS_CONFIGURATION_SCHEMA } from '../src/schemas/https.configuration.js';
import shipped from '../src/config/https.js';

class NoSource extends ConfigurationSource {
  public get Order() {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({} as IConfigLike);
  }
}

describe('https configuration schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function violationsOf(config: unknown): Promise<string[]> {
    const child = DI.child();
    children.push(child);
    child.register(HTTPS_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
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

  it('accepts the shipped default and an app that turns https on', async () => {
    expect(shipped.https).to.equal(false);
    expect(await violationsOf(shipped)).to.deep.equal([]);
    expect(await violationsOf({ https: true })).to.deep.equal([]);
  });

  it('refuses a value that is not a boolean, a null included', async () => {
    expect(await violationsOf({ https: 'maybe' })).to.deep.equal(['https']);
    expect(await violationsOf({ https: null })).to.deep.equal(['https']);
  });
});
