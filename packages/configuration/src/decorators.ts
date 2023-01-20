import { isArray, isString } from 'lodash';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration, IConfigEntryOptions } from '@spinajs/configuration-common';
import { AddDependency, Class, DI, IContainer, IInjectDescriptor, IMappableService } from '@spinajs/di';

/**
 * Injects configuration value to given class property
 *
 * @param path - path to configuration value eg. "app.dirs.stats"
 * @param dafaultValue - default value if path not exists
 * @returns
 */
export function Config(path: string, options?: IConfigEntryOptions) {
  return (target?: any, key?: string): any => {
    let config: Configuration = null;

    // register conf, so we can expose eg. in db if config is set
    DI.register({ path, options }).asValue('__configuration_property__');

    const getter = () => {
      if (!config) {
        config = DI.get(Configuration);
      }

      // try to return val
      return config.get(path, options ? options.defaultValue ?? undefined : undefined);
    };

    Object.defineProperty(target, key, {
      get: getter,
      enumerable: false,
      configurable: false,
    });
  };
}

/**
 * Inject service based on configuration.
 * Configuration could be object or string containing service
 *
 * If array is provided in configuration, service is resolved by name
 * stored in 'service' property and returnes as Map\<serviceName, instance\>
 *
 * @param path - configuration path where service type is stored
 * @param type - if type is provided, it will override type obtain from reflection. Use it specific with arrays and maps, becouse ts reflection module cannot extract array and map type data
 */
export function AutoinjectService(path: string, type?: Class<unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return AddDependency((descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string) => {
    const t = type ?? (Reflect.getMetadata('design:type', target, propertyKey) as Class<unknown>);
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: t,
      data: path,
      mapFunc: (x: IMappableService) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
        return x.ServiceName || x.constructor.name;
      },
      serviceFunc: (path: string, container: IContainer) => {
        const cfg = container.get(Configuration);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const cfgVal = cfg.get<any>(path);

        if (!cfgVal) {
          throw new Error(`Configuration value ${path} is empty`);
        }

        if (isString(cfgVal)) {
          return {
            service: cfgVal,
          };
        }

        if (isArray(cfgVal)) {
          return cfgVal.map((x) => {
            return {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
              service: x.service as string,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              options: x,
            };
          });
        }

        return {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          service: cfgVal.service as string,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          options: cfgVal,
        };
      },
    });
  });
}
