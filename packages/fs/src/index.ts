import { Config, InvalidConfiguration } from '@spinajs/configuration';
import { AsyncService, ResolveException, sortByDependencies } from '@spinajs/di';
import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { fs, IFsConfiguration, IProviderConfiguration } from './interfaces.js';
import { Log, Logger } from '@spinajs/log-common';

export * from './interfaces.js';
export * from './local-provider.js';
export * from './temp-provider.js';
export * from './temp-cleanup-strategy.js';
export * from './decorators.js';
export * from './file-hasher.js';
export * from './file-info.js';
export * from './helpers.js';
export * from './fp.js';
export * from './paths.js';
export * from './actions.js';

/** DI key of the `Map<string, fs>` that fsService publishes every provider into, by name. */
export const FILE_PROVIDER_INSTANCES = '__file_provider_instance__';

/** The provider fsService published under `name`, or `undefined`. */
export function publishedFs(name: string, container: IContainer = DI.RootContainer): fs | undefined {
  const published = container.get<Map<string, fs>>(FILE_PROVIDER_INSTANCES);
  return published instanceof Map ? published.get(name) : undefined;
}

export class fsService extends AsyncService {
  @Logger('fs')
  protected Logger: Log;

  @Config('fs')
  protected Config: IFsConfiguration;

  public async resolve() {

    await super.resolve();

    if (this.Config.defaultProvider === undefined) {
      throw new InvalidConfiguration('fs default provider is not set. Please set default file provider ');
    }

    const providers = new Map<string, IProviderConfiguration>();
    // collapse provider config
    // when name is the same, addes last is created
    // eg fs-temp can have default config from package
    // but is overriden in application
    this.Config.providers.forEach((x) => {
      providers.set(x.name, x);
    });

    // getTypes() returns null when nothing is registered under the token
    const rProviders = DI.RootContainer.Registry.getTypes(fs) ?? [];

    // order provider creation so that providers referencing other providers
    // ( eg. fsTemp backend via `provider` option ) are created after their dependency,
    // regardless of config order. Fails fast on missing / self / circular reference.
    const ordered = sortByDependencies(
      Array.from(providers.values()),
      (p) => p.name,
      (p) => p.provider,
    );

    const list = ordered.map((value) => ({ name: value.name, value }));

    for (const cProvider of list) {
      const type = rProviders.find((x: any) => x.name === cProvider.value.service);

      if (!type) {
        throw new ResolveException(
          `Type ${cProvider.value.service} not registered, make sure all fs providers are registered`,
        );
      }

      const fs = await DI.resolve<fs>(type, [cProvider.value]);
      DI.register(fs).asMapValue(FILE_PROVIDER_INSTANCES, cProvider.value.name);

      this.Logger.info(
        { provider: cProvider.value.name, service: cProvider.value.service },
        'File provider ${provider} registered, type: ${service}',
      );
    }
  }
}

@Injectable(Bootstrapper)
export class FsBootstrapper extends Bootstrapper {
  public bootstrap() {
    DI.register((_container: IContainer, name: string) => {
      const provider = DI.get<Map<string, fs>>(FILE_PROVIDER_INSTANCES);

      if(!provider) {
        throw new ResolveException(`No __file_provider_instance__ registered, make sure fs package is imported in your application and fsService is resolved.`);
      }

      const instance = provider.get(name);

      if (!instance) {
        throw new ResolveException(`File provider ${name} not registered, make sure you have registered file provider with name ${name}`);
      }
      
      return instance;
    }).as('__file_provider__');
  }
}

/**
 * @deprecated misspelled, use {@link FsBootstrapper}
 */
export const FsBootsrapper = FsBootstrapper;
/**
 * @deprecated misspelled, use {@link FsBootstrapper}
 */
export type FsBootsrapper = FsBootstrapper;
