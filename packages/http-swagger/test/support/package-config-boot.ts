// For the probes that run in a fresh process: boots http-swagger with its own package config merged into the test
// config. Set WORKSPACE_ROOT_PATH before calling; the package config resolves its folders from it when it is imported.
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { IConfigLike } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { TestConfiguration, srcDir } from '../common.js';

type PackageHttp = (typeof import('../../src/config/http-swagger.js'))['default']['http'];
type TestHttp = { swagger: Record<string, unknown> };

/**
 * `http` gets the package config's `http` and the test config's `http` and returns the merged `http`. `register` runs
 * after the configuration is registered and before anything resolves.
 */
export async function bootWithPackageConfig(http: (pkg: PackageHttp, test: TestHttp) => object, register?: () => void): Promise<void> {
  const { default: packageConfig } = await import('../../src/config/http-swagger.js');

  // Reloaded through `load()` so the ConfigVars of both configs are wrapped as in an app.
  class PackageConfiguration extends TestConfiguration {
    private loaded: IConfigLike = {};

    public async resolve(): Promise<void> {
      await super.resolve();
      this.loaded = {
        ...this.Config,
        system: { dirs: { controllers: [srcDir('./controllers')] } },
        http: http(packageConfig.http, this.Config.http as TestHttp),
      };
      // Only onLoad(): the file sources would bring in the config of every installed package.
      this.Sources = [];
      await this.load();
    }

    protected onLoad(): IConfigLike {
      return this.loaded;
    }
  }

  DI.setESMModuleSupport();
  DI.register(PackageConfiguration).as(Configuration);
  register?.();
  DI.resolve(FsBootsrapper).bootstrap();
  await DI.resolve(Configuration);
  await DI.resolve(fsService);
  await DI.resolve(Controllers);
  await (await DI.resolve<HttpServer>(HttpServer)).start();
}
