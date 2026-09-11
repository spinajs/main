import _ from 'lodash';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration, IConfigEntryOptions } from '@spinajs/configuration-common';
import { AddDependencyForProperty, Class, DI, IContainer, IInjectDescriptor, IMappableService } from '@spinajs/di';
import { InternalLogger } from '@spinajs/internal-logger';

/**
 * Injects configuration value into a class property.
 *
 * The decorated property is replaced with a lazy getter. Every read resolves the
 * {@link Configuration} service and calls `config.get(path, options.defaultValue)`,
 * so the property always reflects the current (possibly reloaded / watched) value
 * instead of a snapshot taken at construction time.
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

    const getter = () => {
      const config = DI.get(Configuration)!;
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
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string | symbol) => {
    const t = type ?? (Reflect.getMetadata('design:type', target, propertyKey) as Class<unknown>);
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: t,
      data: path,
      mapFunc: (x: IMappableService) => {
        return x.ServiceName || x.constructor.name;
      },
      serviceFunc: (data: string | any[], container: IContainer) => {
        const cfg = container.get(Configuration);

        if (!cfg) {
          throw new Error(`Configuration service is not registered in DI container. Cannot autoinject service for property ${propertyKey.toString()}, path: ${data}`);
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
