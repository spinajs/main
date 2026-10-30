import 'mocha';
import { expect } from 'chai';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, FrameworkConfiguration, IConfigLike, InvalidConfiguration } from '@spinajs/configuration';
import { FS_CONFIGURATION_SCHEMA } from '../src/schemas/fs.configuration.js';

class NoSource extends ConfigurationSource {
  public get Order() {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({} as IConfigLike);
  }
}

describe('fs configuration schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function violationsOf(fs: unknown): Promise<string[]> {
    const child = DI.child();
    children.push(child);
    child.register(FS_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
    child.register(NoSource).as(ConfigurationSource);
    child
      .register(
        class extends FrameworkConfiguration {
          protected loadSources(): void {
            this.Sources = [];
          }

          protected onLoad(): unknown {
            return { fs };
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

  it('accepts providers with their own options and sections of other packages', async () => {
    expect(
      await violationsOf({
        defaultProvider: 'documents',
        providers: [
          { service: 'fsNative', name: 'documents', basePath: './data' },
          { service: 'fsTemp', name: 'tmp', provider: 'documents', cleanup: true },
        ],
        hasher: { defaultAlgorithm: 'sha512' },
        fileInfo: { timeout: 5000, args: ['-n', '-G'] },
        middlewareTimeoutMs: 1000,
        onedrive: { clientId: 'x' },
      }),
    ).to.deep.equal([]);
  });

  it('refuses a provider without a service and a wrong typed timeout', async () => {
    expect(await violationsOf({ defaultProvider: 'documents', providers: [{ name: 'documents' }] })).to.deep.equal(['fs.providers.0.service']);
    expect(await violationsOf({ providers: [], fileInfo: { timeout: 'soon' } })).to.deep.equal(['fs.fileInfo.timeout']);
    expect(await violationsOf({ providers: 'documents' })).to.deep.equal(['fs.providers']);
  });
});
