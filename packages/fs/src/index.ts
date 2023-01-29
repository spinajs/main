import { Configuration, InvalidConfiguration } from '@spinajs/configuration';
import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { fs, IFsConfiguration } from './interfaces.js';

export * from './interfaces.js';
export * from './local-provider.js';
export * from './decorators.js';

@Injectable(Bootstrapper)
export class FsBootsrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(async (container: IContainer, name?: string) => {
      const cfg = container.get(Configuration).get<IFsConfiguration>('fs');
      const defaultProvider = cfg.defaultProvider;

      if (!defaultProvider) {
        throw new InvalidConfiguration('fs default provider is not set. Please set default file provider ');
      }

      const cProvider = cfg.providers.find((x) => x.name === (name ?? defaultProvider));
      const rProviders = DI.RootContainer.Registry.getTypes(fs);
      const provider = await DI.resolve<fs>(
        rProviders.find((x) => x.name === cProvider.service),
        [cProvider],
      );

      return provider;
    }).as('__file_provider__');
  }
}
