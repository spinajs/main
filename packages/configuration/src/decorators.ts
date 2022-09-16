/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration } from '@spinajs/configuration-common';
import { AddDependency, Class, DI, IContainer, IInjectDescriptor } from '@spinajs/di';

/**
 * Injects configuration value to given class property
 *
 * @param path - path to configuration value eg. "app.dirs.stats"
 * @param dafaultValue - default value if path not exists
 * @returns
 */
export function Config(path: string, dafaultValue?: unknown) {
  return (target?: any, key?: string): any => {
    let config: Configuration = null;

    const getter = () => {
      if (!config) {
        config = DI.get(Configuration);
      }
      return config.get(path, dafaultValue);
    };

    Object.defineProperty(target, key, {
      get: getter,
      enumerable: false,
      configurable: false,
    });
  };
}

interface IServiceCfg {
  path: string;
}

export function AutoinjectService(path: string) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return AddDependency((descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target, propertyKey) as Class<unknown>;
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: type,
      data: {
        path,
      },
      serviceFunc: (data: IServiceCfg, container: IContainer) => {
        const cfg = container.get(Configuration);
        return cfg.get<string>(data.path);
      },
    });
  });
}
