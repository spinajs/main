import _ from 'lodash';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigPath, ConfigPaths, Configuration, IConfigEntryOptions, CONFIGURATION_PROPERTY } from '@spinajs/configuration-common';
import { AddDependencyForProperty, Class, Container, DI, IContainer, IInjectDescriptor, IMappableService, IToInject, isFactory, isPromise, ServiceNotFound } from '@spinajs/di';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { InternalLogger } from '@spinajs/internal-logger';

export const CONFIGURATION_CONTAINER_KEY = '__configurationContainer__';

/** Makes the `@Config` properties of `instance`, built with `new` rather than by DI, read the Configuration of `container`. */
export function bindConfigurationContainer<T extends object>(instance: T, container: IContainer): T {
  Object.defineProperty(instance, CONFIGURATION_CONTAINER_KEY, { value: container, configurable: true, writable: true });
  return instance;
}

/**
 * Reads the Configuration owned by the nearest container (self or ancestor) that registers one.
 * Never goes through `Container.get`'s parent walk: it matches by type name, so a same-named
 * class in an ancestor would hand out the ancestor's instance.
 */
function getOwnConfiguration(container: IContainer): Configuration | null {
  const owner = configurationOwner(container) ?? DI.RootContainer;

  if (registersFactory(owner)) {
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

function registersFactory(owner: IContainer): boolean {
  const types = owner.getRegisteredTypes(Configuration, false) ?? [];
  return isFactory(types[types.length - 1]);
}

/** The nearest container (self or ancestor) that registers a Configuration. */
function configurationOwner(container: IContainer): IContainer | undefined {
  let owner: IContainer | undefined = container;
  while (owner && !owner.Registry.ownsRegistration(Configuration)) {
    owner = owner.Parent;
  }
  return owner;
}

/**
 * {@link getOwnConfiguration}, resolving the owner's Configuration first when it is registered but not resolved yet:
 * property dependencies resolve together, so `@Autoinject(Configuration)` cannot run before this. A resolve already
 * in flight is shared by the container. Null only when no container in the lineage registers a Configuration.
 */
async function resolveOwnConfiguration(container: IContainer): Promise<Configuration | null> {
  const owner = configurationOwner(container);
  // A factory result is never cached: one resolve is the only read, a second would run the factory again.
  if (owner && registersFactory(owner)) return (await owner.resolve(Configuration)) as Configuration;

  const cfg = getOwnConfiguration(container);
  if (cfg) return cfg;
  if (!owner) return null;
  const resolved = (await owner.resolve(Configuration)) as Configuration;
  return getOwnConfiguration(container) ?? resolved;
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
export function Config<P extends ConfigPath>(path: P, options?: IConfigEntryOptions & { defaultValue?: ConfigPaths[P] }): PropertyDecorator;
export function Config(path: string, options?: IConfigEntryOptions): PropertyDecorator;
export function Config(path: string, options?: IConfigEntryOptions) {
  return (target: any, key: string): any => {
    // register conf, so we can expose eg. in db if config is set
    DI.register({ path, options }).asValue(CONFIGURATION_PROPERTY.key);

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
 * Resolves the services named by the list at `path` in `container`: the entries,
 * each `{ [keyBy], service }`, in list order. An unset path gives an empty Map.
 *
 * Not for classes the Configuration itself resolves (sources, protocols): it awaits that Configuration.
 *
 * @throws ServiceNotFound when no registration of `type` is named as an entry's service
 * @throws InvalidOption when the value is not a list, a key is listed twice, or an instance's key differs from its entry's
 */
export async function resolveNamedServices<T>(container: IContainer, path: string, type: Class<T>, options: IAutoinjectServiceOptions): Promise<Map<string, T>> {
  const cfg = await resolveOwnConfiguration(container);
  if (!cfg) {
    throw new InvalidOperation(`Cannot resolve the services of ${path}: no container in the lineage registers a Configuration`);
  }

  const { keyBy } = options;
  const entries = cfg.get<unknown>(path) ?? [];
  if (!Array.isArray(entries)) {
    throw new InvalidOption(`${path} must be a list`);
  }

  const registered = container.getRegisteredNames(type);
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

    if (!registered.includes(service)) {
      throw new ServiceNotFound(`${path} entry ${q(key)}: no ${type.name} is registered as service ${q(service)}`);
    }

    const instance = await container.resolveNamed(type, service);
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
 * Injects what {@link resolveNamedServices} gives for `path` in the resolving container: a Map keyed by each entry's
 * `keyBy`, in list order, looked up across the container lineage. Resolved when the instance is built, so an unknown
 * service or a bad list rejects that resolve.
 *
 * @example
 * ```ts
 * @AutoinjectNamedServices('authn.mfa.steps', MfaStep, { lineage: true, keyBy: 'name' })
 * protected Steps: Map<string, MfaStep>;
 * ```
 */
export function AutoinjectNamedServices<T>(path: string, type: Class<T>, options: IAutoinjectServiceOptions) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, _target: Class<unknown>, propertyKey: string | symbol) => {
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: type,
      data: path,
      resolveFunc: (data: string, container: IContainer) => resolveNamedServices(container, data, type, options),
    });
  });
}

export interface INamedServiceOptions<T> {
  /**
   * Used when the value at `path` is unset or ''. A class must be a subclass of `type`; any other function is treated
   * as a picker, which gets the registered names and returns one, or undefined when none fits.
   */
  default?: string | Class<T> | ((registered: readonly string[]) => string | undefined);
  /** Duck check of the resolved instance (instanceof fails across cjs/mjs copies). */
  is?: (instance: unknown) => boolean;
  /** Undefined instead of InvalidOption when no name applies: the value is unset and there is no default, or the picker returns none. */
  optional?: boolean;
}

/**
 * The one service of `type` named by the value at `path` in `container`'s configuration, or by `options.default` when
 * that is unset. Looked up by registration name across the container lineage, nearest container first.
 * Not for classes the Configuration itself resolves (sources, protocols): it awaits that Configuration.
 *
 * @throws InvalidOption when the value is not a string, no name applies (unless `options.optional`), the name is not registered, or `options.is` rejects the instance
 */
export async function resolveNamedService<T>(container: IContainer, path: string, type: Class<T>, options: INamedServiceOptions<T> & { optional: true }): Promise<T | undefined>;
export async function resolveNamedService<T>(container: IContainer, path: string, type: Class<T>, options?: INamedServiceOptions<T>): Promise<T>;
export async function resolveNamedService<T>(container: IContainer, path: string, type: Class<T>, options: INamedServiceOptions<T> = {}): Promise<T | undefined> {
  const cfg = await resolveOwnConfiguration(container);
  if (!cfg) {
    throw new InvalidOperation(`Cannot resolve the service of ${path}: no container in the lineage registers a Configuration`);
  }

  const registered = container.getRegisteredNames(type);
  const listed = registered.map(q).join(', ') || 'none';
  const value = cfg.get<unknown>(path);
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new InvalidOption(`${path} must be a string`);
  }
  let name = value === '' ? undefined : (value as string | null | undefined) ?? undefined;
  if (name === undefined) {
    const fallback = options.default;
    if (fallback === undefined) {
      if (options.optional) return undefined;
      throw new InvalidOption(`${path} is not set (registered: ${listed})`);
    }
    name = typeof fallback === 'string' ? fallback : fallback.prototype instanceof type ? fallback.name : (fallback as (registered: readonly string[]) => string | undefined)(registered);
    if (name === undefined && options.optional) return undefined;
    if (name === undefined) throw new InvalidOption(`${path} is not set and no ${type.name} is the default among those registered (${listed}); name one`);
  }

  if (!registered.includes(name)) {
    throw new InvalidOption(`${path} ${q(name)}: no ${type.name} is registered under that name (registered: ${listed})`);
  }
  const instance = await container.resolveNamed(type, name);
  if (options.is && !options.is(instance)) {
    throw new InvalidOption(`${path} ${q(name)} is not an ${type.name}`);
  }
  return instance;
}

/**
 * Injects {@link resolveNamedService} for `path` in the resolving container, when the instance is built. With
 * `optional: true` an unset `path` injects undefined.
 *
 * @example
 * ```ts
 * @AutoinjectNamedService('authn.mfa.policy.service', MfaPolicy, { default: 'DefaultMfaPolicy' })
 * protected Policy: MfaPolicy;
 * ```
 */
export function AutoinjectNamedService<T>(path: string, type: Class<T>, options?: INamedServiceOptions<T>) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, _target: Class<unknown>, propertyKey: string | symbol) => {
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: type,
      data: path,
      resolveFunc: (data: string, container: IContainer) => resolveNamedService(container, data, type, options),
    });
  });
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
 * @param options - `optional: true` leaves the property undefined (with a warning) when the value at `path` is empty
 * @throws InvalidOperation when the value at `path` is empty and the injection is not optional
 */
export function AutoinjectService(path: string, type?: Class<unknown>, options?: { optional?: boolean }) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string | symbol) => {
    const declared = type ?? (Reflect.getMetadata('design:type', target, propertyKey) as Class<unknown> | undefined);
    const injection = (inject: Class<unknown>): IToInject<unknown> => ({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject,
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
          if (!options?.optional) {
            throw new InvalidOperation(`Configuration value at ${String(data)} is empty. Cannot autoinject service for property ${propertyKey.toString()}`);
          }
          InternalLogger.warn({ path: data, property: propertyKey.toString() }, 'Configuration value for path ${path} is empty. Cannot autoinject service for property ${property}', "Configuration");
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

    descriptor.inject.push(declared ? injection(declared) : { ...injection(Object), pendingType: { property: propertyKey, bind: injection } });
  });
}
