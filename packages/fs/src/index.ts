import { Config, InvalidConfiguration } from '@spinajs/configuration';
import { AsyncService, ResolveException, sortByDependencies } from '@spinajs/di';
import { Injectable, Bootstrapper, DI, IContainer } from '@spinajs/di';
import { fs, FsDecorator, IFsConfiguration, IProviderConfiguration } from './interfaces.js';
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

    const rProviders = DI.RootContainer.Registry.getTypes(fs);

    // order provider creation so that providers referencing other providers
    // ( eg. fsTemp backend via `provider` option ) are created after their dependency,
    // regardless of config order. Fails fast on missing / self / circular reference.
    const ordered = sortByDependencies(
      Array.from(providers.values()),
      (p) => p.name,
      (p) => p.provider,
    );

    const list = ordered.map((value) => ({ name: value.name, value }));
    const created: [IProviderConfiguration, fs][] = [];

    for (const cProvider of list) {
      const type = rProviders.find((x: any) => x.name === cProvider.value.service);

      if (!type) {
        throw new ResolveException(
          `Type ${cProvider.value.service} not registered, make sure all fs providers are registered`,
        );
      }

      const fs = await DI.resolve<fs>(type, [cProvider.value]);
      DI.register(fs).asMapValue('__file_provider_instance__', cProvider.value.name);
      created.push([cProvider.value, fs]);

      this.Logger.info(`File provider ${cProvider.value.name} registered, type: ${cProvider.value.service}`);
    }

    // Only after every provider exists, so providers that looked up others by name
    // in their own resolve() ( eg. fsTemp backends ) keep the raw instances.
    await this.decorate(created);
  }

  protected async decorate(providers: [IProviderConfiguration, fs][]) {
    const decorators = [...(await DI.resolve(Array.ofType(FsDecorator)))].sort((a, b) => a.order - b.order);

    if (decorators.length === 0) {
      return;
    }

    const names = decorators.map((d) => `${d.constructor.name}(${d.order})`).join(', ');

    for (const [config, raw] of providers) {
      const decorated = decorators.reduce((current, d) => d.decorate(current, config), raw);
      DI.register(decorated).asMapValue('__file_provider_instance__', config.name);

      this.Logger.info(`File provider ${config.name} decorated with ${names}`);
    }
  }
}

@Injectable(Bootstrapper)
export class FsBootsrapper extends Bootstrapper {
  public bootstrap() {
    DI.register((_container: IContainer, name: string) => {
      const provider = DI.get<Map<string, fs>>('__file_provider_instance__');

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
