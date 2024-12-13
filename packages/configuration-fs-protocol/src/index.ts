import { ConfigVar, ConfigVarProtocol } from '@spinajs/configuration-common';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { fs } from '@spinajs/fs';

@Singleton()
@Injectable(ConfigVarProtocol)
export class ConfigurationFsProtocol extends ConfigVarProtocol {
  get Protocol(): string {
    return 'fs://';
  }

  public async getVar(path: string): Promise<unknown> {
    // we defer invocation of path resolve
    // to be sure Config & fsService are resolved
    return new ConfigVar(() => {
      const args = path.split('/');
      const fsName = args[0];
      const fPath = args[1];
      const f = DI.resolve<fs>('__file_provider__', [fsName]);

      if (f) {
        return f.resolvePath(fPath);
      }

      return null;
    });
  }
}
