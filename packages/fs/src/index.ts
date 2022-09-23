import { Configuration } from '@spinajs/configuration';
import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { fs, IFsConfiguration } from './interfaces';

export * from './interfaces';
export * from './local-provider';

@Injectable(Bootstrapper)
export class FsBootsrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(async (container: IContainer, name?: string) => {
      const cfg = container.get(Configuration).get<IFsConfiguration>('fs');
      const defaultProvider = cfg.defaultProvider;

      let provider = DI.get<fs>(Array.ofType(fs)).find((x) => x.Name === name ?? defaultProvider);
      if (!provider) {
        const cProvider = cfg.providers.find((x) => x.name === name ?? defaultProvider);

        provider = await DI.resolve(cProvider.service, [cProvider]);
      }

      return provider;
    }).as('__file_provider__');
  }
}
