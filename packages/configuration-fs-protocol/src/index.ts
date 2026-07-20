import { ConfigVar, ConfigVarProtocol } from '@spinajs/configuration-common';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { fs } from '@spinajs/fs';
import { InternalLogger } from '@spinajs/internal-logger';


@Singleton()
@Injectable(ConfigVarProtocol)
export class ConfigurationFsPathProtocol extends ConfigVarProtocol {
  get Protocol(): string {
    return 'fs-path://';
  }

  public async getVar(path: string): Promise<any> {
    // we defer invocation of path resolve
    // to be sure Config & fsService are resolved
    return new ConfigVar(() => {

      const reg = /^(.*)\/(.*)/;
      const args = path.match(reg);

      if (!args || args.length < 3) {
        InternalLogger.warn(`Invalid fs-path variable format: ${path}, expected format is fs-path://filesystemName/path/to/file`, 'Configuration');
        return null;
      }

      const fsName = args[1];
      const fPath = args[2];

      // fs providers are registered by fsService AFTER configuration is resolved.
      // When the var is dereferenced too early ( or the fs name is unknown ), warn
      // and return null instead of throwing - ConfigVar caches only truthy values,
      // so the lookup is retried on next access and resolves once fsService is up.
      try {
        const f = DI.resolve<fs>('__file_provider__', [fsName]);

        if (f) {
          return f.resolvePath(fPath);
        }

        InternalLogger.warn(`fs-path filesystem ${fsName} not exists, check your configuration file !`, 'Configuration');
      } catch (err) {
        InternalLogger.warn(
          `Cannot resolve fs-path variable ${path} yet: ${(err as Error).message}. Returning null, value will be retried on next access.`,
          'Configuration',
        );
      }

      return null;
    });
  }
}
