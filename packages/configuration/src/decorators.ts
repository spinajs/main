import _ from 'lodash';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration, IConfigEntryOptions } from '@spinajs/configuration-common';
import { AddDependencyForProperty, Class, Container, DI, IContainer, IInjectDescriptor, IMappableService, isFactory, isPromise, ServiceNotFound } from '@spinajs/di';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { InternalLogger } from '@spinajs/internal-logger';

export const CONFIGURATION_CONTAINER_KEY = '__configurationContainer__';

/**
 * Reads the Configuration owned by the nearest container (self or ancestor) that registers one.
 * Never goes through `Container.get`'s parent walk: it matches by type name, so a same-named
 * class in an ancestor would hand out the ancestor's instance.
 */
function getOwnConfiguration(container: IContainer): Configuration | null {
  let owner: IContainer | undefined = container;
  while (owner && !owner.Registry.ownsRegistration(Configuration)) {
    owner = owner.Parent;
  }
  owner ??= DI.RootContainer;

  const types = owner.getRegisteredTypes(Configuration, false) ?? [];
  if (isFactory(types[types.length - 1])) {
    // A factory result is never cached, so it can only be read by resolving it.
    const resolved = owner.resolve(Configuration);
    if (isPromise(resolved)) {
      resolved.catch(() => undefined);
      return null;
    }
    return resolved as Configuration;
  }

  return owner.get(Configuration, false);
}

/**
 * Injects configuration value into a class property.
 *
 * The decorated property is replaced with a lazy getter. Every read asks the
 * {@link Configuration} of the container that built the instance, which must be resolved
 * before the property is read, and calls `config.get(path, options.defaultValue)`,
 * so the property always reflects the current (possibly reloaded / watched) value
 * instead of a snapshot taken at construction time.
 *
 * Properties are read in `resolve()` or later. During the constructor or a field initializer
 * the container is not injected yet, so the root Configuration is read (as for an instance
 * built with `new`).
 *
 * Besides defining the getter, the decorator registers `{ path, options }` in the DI
 * container under `__configuration_property__`. Other modules listen for these
 * registrations - eg. `@spinajs/configuration-db-source` uses them to persist
 * (expose) entries in the database and to watch them for changes.
 *
 * ### Value resolution & priority
 *
 * The configuration is a merge of all registered `ConfigurationSource`s (json / js
 * files, env, db, ...) applied in their `Order`. The getter reads the merged value at
 * `path` with lodash `_.get` semantics:
 *
 *  - `defaultValue` is a **fallback only**. It is returned when no source provides a
 *    value at `path` (the resolved value is `undefined`).
 *  - when any source provides a value at `path`, that value is returned and
 *    `defaultValue` is ignored. The db source loads last (`Order` 999), so an exposed
 *    db row overrides the same key coming from files.
 *  - with `expose: true` the entry is inserted into the `configuration` table on first
 *    run (InsertOrIgnore) with both `Value` and `Default` columns seeded from
 *    `defaultValue`. From then on the db row is the source of truth for that key:
 *    reading it - via `@Config` or plain `Configuration.get(path)` - returns the db
 *    `Value`, and editing the row changes what the property returns (immediately with
 *    `watch: true`, otherwise after restart / `Configuration.load()`). `defaultValue`
 *    is used again only when the row cannot be loaded (no db connection, table not
 *    migrated, row deleted, `Exposed` flag cleared).
 *  - reading a key without `defaultValue` simply returns whatever the sources loaded:
 *    for an exposed entry the db `Value`, or `undefined` / `null` when it is empty.
 *
 * ### Options ({@link IConfigEntryOptions})
 *
 *  - `defaultValue` - value returned when `path` is not present in the merged config.
 *    When the entry is exposed it also seeds the db row (`Value` and `Default`).
 *  - `required` - marks the entry as required. Persisted to the `Required` column of
 *    the exposed db row (informational, for admin UIs); the getter does not enforce it.
 *  - `expose` - (db source) when `true` the entry is persisted in the `configuration`
 *    table so it can be administered at runtime. Only rows with the `Exposed` flag are
 *    loaded back into the config. Requires `@spinajs/configuration-db-source` and a
 *    resolved `Orm` - without the ORM nothing is written or watched.
 *  - `exposeOptions` - (db source) metadata of the exposed row:
 *     - `type` - entry type (`string`, `number`, `float`, `boolean`, `json`, `date`,
 *       `time`, `datetime`, `*-range`, `oneOf`, `manyOf`, `range`, `file`). Drives how
 *       `Value` is serialized to and parsed from the db.
 *     - `group` - display-only grouping label for admin UIs. It is NOT part of the
 *       config path - `Slug` (the `path` argument) is the canonical path.
 *     - `label`, `description` - human readable name and help text.
 *     - `meta` - validation hints for UIs (`min`, `max`, `oneOf`, `manyOf`, `minDate`,
 *       `maxDate`), stored as JSON.
 *     - `watch` - when `true` the db row is polled (every 3 min by default, override
 *       with the `__config_watch_interval__` DI value) and changes are pushed into
 *       the live configuration without restarting the app.
 *  - value schema - not an option: a JSON schema registered in `@spinajs/validation` with
 *    `$id` equal to `path` is enforced by `@spinajs/configuration-http` on updates.
 *
 * @example
 * ```ts
 * class MailService {
 *   // value from files / env, "no-reply@example.com" when the key is missing
 *   @Config('mailer.fromAddress', { defaultValue: 'no-reply@example.com' })
 *   protected From: string;
 *
 *   // exposed to db, editable at runtime, refreshed without restart
 *   @Config('mailer.retryCount', {
 *     defaultValue: 3,
 *     expose: true,
 *     exposeOptions: { type: 'number', group: 'mailer', label: 'Retry count', watch: true },
 *   })
 *   protected Retries: number;
 * }
 * ```
 *
 * @param path - path to configuration value eg. "app.dirs.stats"
 * @param options - entry options, see {@link IConfigEntryOptions}
 * @returns property decorator
 */
export function Config(path: string, options?: IConfigEntryOptions) {
  return (target: any, key: string): any => {
    // register conf, so we can expose eg. in db if config is set
    DI.register({ path, options }).asValue('__configuration_property__');

    // The container is injected, not the (async) Configuration, so the class keeps resolving synchronously.
    AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>) => {
      if (!descriptor.inject.some((i) => i.autoinjectKey === CONFIGURATION_CONTAINER_KEY)) {
        descriptor.inject.push({ autoinject: true, autoinjectKey: CONFIGURATION_CONTAINER_KEY, inject: Container, mapFunc: undefined });
      }
    })(target, key);

    Object.defineProperty(target, key, {
      get(this: Record<string, IContainer | undefined>) {
        const container = this[CONFIGURATION_CONTAINER_KEY];
        const config = container ? getOwnConfiguration(container) : DI.get(Configuration);
        if (!config) {
          throw new InvalidOperation(`Cannot read configuration path ${path}: the Configuration of the container is not resolved`);
        }

        return config.get(path, options ? options.defaultValue ?? undefined : undefined);
      },
      enumerable: false,
      configurable: false,
    });
  };
}

export interface IAutoinjectServiceOptions {
  /** Services are looked up by registration name across the container lineage, nearest container first. */
  lineage: true;
  /** The configured list is injected as a Map keyed by this property of each entry; the instance must carry the same value. */
  keyBy: string;
}

const q = (v: unknown): string => JSON.stringify(v) ?? String(v);

/**
 * What `@AutoinjectService(path, type, options)` injects, resolved in `container`: the entries of the list at `path`,
 * each `{ [keyBy], service }`, in list order. An unset path gives an empty Map.
 *
 * @throws ServiceNotFound when no registration of `type` is named as an entry's service
 * @throws InvalidOption when the value is not a list, a key is listed twice, or an instance's key differs from its entry's
 */
export async function resolveNamedServices<T>(container: IContainer, path: string, type: Class<T>, options: IAutoinjectServiceOptions): Promise<Map<string, T>> {
  const cfg = getOwnConfiguration(container);
  if (!cfg) {
    throw new InvalidOperation(`Cannot resolve the services of ${path}: the Configuration of the container is not resolved`);
  }

  const { keyBy } = options;
  const entries = cfg.get<unknown>(path) ?? [];
  if (!Array.isArray(entries)) {
    throw new InvalidOption(`${path} must be a list`);
  }

  const services = new Map<string, T>();
  for (const entry of entries as Record<string, unknown>[]) {
    const key = entry?.[keyBy];
    const service = entry?.service;
    if (typeof key !== 'string' || typeof service !== 'string') {
      throw new InvalidOption(`${path}: every entry needs a string ${keyBy} and service`);
    }
    if (services.has(key)) {
      throw new InvalidOption(`${path} lists ${keyBy} ${q(key)} twice`);
    }

    const instance = await container.resolveNamed(type, service);
    if (instance === undefined) {
      throw new ServiceNotFound(`${path} entry ${q(key)}: no ${type.name} is registered as service ${q(service)}`);
    }

    const own = (instance as Record<string, unknown> | null)?.[keyBy];
    if (own !== key) {
      const has = typeof own === 'string' ? `${keyBy} ${q(own)}` : `no ${keyBy}`;
      throw new InvalidOption(`${path} entry ${q(key)} (service ${q(service)}): the service has ${has}; the entry must match it`);
    }

    services.set(key, instance);
  }

  return services;
}

/**
 * Inject service based on configuration.
 * Configuration could be object or string containing service
 *
 * If array is provided in configuration, service is resolved by name
 * stored in 'service' property and returnes as Map\<serviceName, instance\>
 *
 * With `options`, the list is resolved by {@link resolveNamedServices} when the instance is built.
 *
 * @param path - configuration path where service type is stored
 * @param type - if type is provided, it will override type obtain from reflection. Use it specific with arrays and maps, becouse ts reflection module cannot extract array and map type data
 */
export function AutoinjectService(path: string, type?: Class<unknown>, options?: IAutoinjectServiceOptions) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string | symbol) => {
    const t = type ?? (Reflect.getMetadata('design:type', target, propertyKey) as Class<unknown>);
    if (options) {
      descriptor.inject.push({
        autoinject: true,
        autoinjectKey: propertyKey,
        inject: t,
        data: path,
        resolveFunc: (data: string, container: IContainer) => resolveNamedServices(container, data, t, options),
      });
      return;
    }

    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: t,
      data: path,
      mapFunc: (x: IMappableService) => {
        return x.ServiceName || x.constructor.name;
      },
      serviceFunc: (data: string | any[], container: IContainer) => {
        const cfg = getOwnConfiguration(container);

        if (!cfg) {
          throw new InvalidOperation(`Cannot autoinject service for property ${propertyKey.toString()}, path: ${String(data)}: the Configuration of the container is not resolved`);
        }

        let cfgVal: any;
        if (typeof data === 'string') {
          cfgVal = cfg.get<any>(data);
        } else {
          cfgVal = data;
        }

        if (!cfgVal) {
          InternalLogger.warn(`Configuration value for path ${data} is empty. Cannot autoinject service for property ${propertyKey.toString()}`, "Configuration");
          return undefined;
        }

        if (_.isString(cfgVal)) {
          return {
            service: cfgVal,
          };
        }

        if (_.isArray(cfgVal)) {
          return cfgVal.map((x) => {
            return {
              service: x.service as string,
              options: x,
            };
          });
        }

        return {
          service: cfgVal.service as string,
          options: cfgVal,
        };
      },
    });
  });
}
