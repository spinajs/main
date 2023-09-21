import { Configuration, InvalidConfiguration } from '@spinajs/configuration';
import { ResolveException } from '@spinajs/di';
import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { fs, IFsConfiguration, IProviderConfiguration } from './interfaces.js';

export * from './interfaces.js';
export * from './local-provider.js';
export * from './local-temp-provider.js';
export * from './decorators.js';
export * from './file-hasher.js';
export * from './file-info.js';

@Injectable(Bootstrapper)
export class FsBootsrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.once('di.resolved.Configuration', (container: IContainer) => {
      const cfg: IFsConfiguration = container.get(Configuration).get<IFsConfiguration>('fs');

      const defaultProvider = cfg.defaultProvider;

      if (!defaultProvider) {
        throw new InvalidConfiguration('fs default provider is not set. Please set default file provider ');
      }

      const providers = new Map<string, IProviderConfiguration>();
      // collapse provider config
      // when name is the same, addes last is created
      // eg fs-temp can have default config from package
      // but is overriden in application
      cfg.providers.forEach((x) => {
        providers.set(x.name, x);
      });

      const rProviders = DI.RootContainer.Registry.getTypes(fs);
      const list = Array.from(providers, ([name, value]) => ({ name, value }));
      for (const cProvider of list) {
        const type = rProviders.find((x: any) => x.name === cProvider.value.service);

        if (!type) {
          throw new ResolveException(
            `Type ${cProvider.value.service} not registered, make sure all fs providers are registered`,
          );
        }

        DI.resolve<fs>(type, [cProvider.value]).then((result: fs) => {
          DI.register(result).asValue('__file_provider_instance_' + cProvider.value.name);
        });
      }
    });

    DI.register((_container: IContainer, name?: string) => {
      const provider = DI.get<fs>('__file_provider_instance_' + name);
      return provider;
    }).as('__file_provider__');
  }
}
