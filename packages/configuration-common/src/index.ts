import { AsyncModule } from '@spinajs/di';

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

export abstract class Configuration extends AsyncModule {
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
