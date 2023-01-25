import { AsyncService, Class } from '@spinajs/di';

export * from './variables.js';

/**
 * App version struct
 */
export interface IFrameworkVersion {
  minor: number;
  major: number;
}

export interface IConfigLike {
  [val: string]: unknown;
}

export interface IConfigurationSchema {
  $configurationModule: string;
}

export interface IConfigurable {
  configure(this: Configuration): void;
}

export interface ConfigurationOptions {
  /**
   * application name, pass it when you run in application mode
   */
  app?: string;

  /**
   * configuration base dir, where to look for application configs
   */
  appBaseDir?: string;

  /**
   * custom cfg paths eg. to load config from non standard folders ( usefull in tests )
   */
  cfgCustomPaths?: string[];

  /**
   * Should watch for changes in config files
   */
  watchFileChanges?: boolean;
}

export abstract class Configuration extends AsyncService {
  /**
   * Root config object, contains whole app configuration
   */
  public abstract get RootConfig(): IConfigLike;

  /**
   * Current running app name
   */
  public RunApp: string;

  /**
   * Apps configuration base dir, where to look for app config
   */
  public AppBaseDir: string;

  /**
   * Get config value for given property. Returns any if value is present, default value if provided or null when empty
   *
   * @param path - path to property eg. ["system","dirs"] or "system" or "system.dirs"
   */
  public abstract get<T>(path: string[] | string, defaultValue?: T): T;

  /**
   * Sets at given path configuration value. Use when you want to override config
   * loaded from files programatically
   *
   * @param path - config path
   * @param value - value to set
   */
  public abstract set(path: string[] | string, value: unknown): void;

  /**
   * Merge existing config value with new options instead overriding
   *
   * @param path - cfg path
   * @param value - value to merge
   */
  public abstract merge(path: string[] | string, value: unknown): void;

  /**
   *
   * Loads & merge configuration loaded from specific source.
   * Use it when you want load configuration not at startup
   * eg. becouse it depends on other module, or some runtime action
   *
   * When there is need for load configuration from source at startup,
   * simply decorate ConfigurationSource class with 'Autoinject' decorator.
   * it will be registered in container and configuration module will resolve and
   * load it automatically
   *
   * @param source - configuration source to load from
   */
  public abstract mergeSource(source: Class<ConfigurationSource>): Promise<void>;

  /**
   * loads configuration from all avaible sources
   */
  public abstract load(): Promise<void>;

  /**
   *
   * Called after configuration reload.
   * Use it to merge custom configuration in custom configuration module.
   * Usefull when writting tests
   *
   */
  protected abstract onLoad(): unknown;
}

export abstract class ConfigurationSource {
  /**
   * Order of cfg sources loading.
   * Some sources need to be loaded before others eg. load db configuration
   * from json, then load config from database using credentials
   * from loaded file
   */
  public abstract get Order(): number;

  public abstract Load(configuration: Configuration): Promise<IConfigLike>;
}

export interface IConfigEntryOptions {
  defaultValue?: unknown;
  required?: boolean;
}
