/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Autoinject, Class, Container, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { join, normalize, resolve } from 'path';
import {
  ConfigurationSource,
  IConfigLike,
  Configuration,
  ConfigurationOptions,
  IConfigurable,
  IConfigurationSchema,
} from '@spinajs/configuration-common';
import { mergeArrays, parseArgv } from './util';
import * as _ from 'lodash';
import Ajv from 'ajv';
import { InvalidConfiguration } from './exception';
import { InternalLogger } from '@spinajs/internal-logger';
import './sources';
import config from './config/configuration';

@Injectable(Configuration)
export class FrameworkConfiguration extends Configuration {
  /**
   * Apps configuration base dir, where to look for app config
   */
  public AppBaseDir = './';

  /**
   * Current running app name
   */
  public RunApp = '';

  /**
   * Loaded & merged configuration
   */
  protected Config: Record<string, unknown> = {};

  protected CustomConfigPaths: string[];

  protected Sources: ConfigurationSource[];

  protected Validator: Ajv;

  protected ValidationSchemas: IConfigurationSchema[];

  public get RootConfig() {
    return this.Config;
  }

  @Autoinject()
  protected Container: Container;

  /**
   *
   * @param app - application name, pass it when you run in application mode
   * @param baseDir - configuration base dir, where to look for application configs
   * @param cfgCustomPaths - custom cfg paths eg. to load config from non standard folders ( usefull in tests )
   */
  constructor(options?: ConfigurationOptions) {
    super();

    this.CustomConfigPaths = options?.cfgCustomPaths ?? [];
    this.RunApp = options?.app ?? parseArgv('--app');
    this.AppBaseDir = options?.appBaseDir ?? parseArgv('--apppath') ?? join(__dirname, '../apps/');
  }

  /**
   * Get config value for given property. If value not exists it returns default value, if default value is not provided returns undefined
   *
   * @param path - path to property eg. ["system","dirs"]
   * @param defaultValue - optional, if value at specified path not exists returns default value
   */
  public get<T>(path: string[] | string, defaultValue?: T): T {
    return _.get(this.Config, path, defaultValue) as T;
  }

  /**
   * Sets at given path configuration value. Use when you want to override config
   * loaded from files programatically
   *
   * @param path - config path
   * @param value - value to set
   */
  public set(path: string[] | string, value: unknown) {
    this.Config = _.set(this.Config, path, value);
  }

  /**
   * Merge existing config value with new options instead overriding
   *
   * @param path - cfg path
   * @param value - value to merge
   */
  public merge(path: string[] | string, value: unknown) {
    _.mergeWith(this.get(path), value, mergeArrays);
  }

  public async resolveAsync(): Promise<void> {
    if (!this.Container.hasRegistered(ConfigurationSource)) {
      throw new InvalidOperation(
        'No configuration sources configured. Please ensure that config module have any source to read from !',
      );
    }

    if (this.CustomConfigPaths) {
      this.CustomConfigPaths.forEach((p) => {
        InternalLogger.trace(`Custom config path at: ${p}`, 'Configuration');
      });
    }

    if (this.RunApp) {
      InternalLogger.trace(`Run app is ${this.RunApp}`, 'Configuration');
    }

    InternalLogger.trace(`App base dir is ${this.AppBaseDir}`, 'Configuration');

    this.initValidator();
    this.applyAppDirs();

    // add default configuration of this module
    // so we dont need to import it
    this.set('configuration', config);

    /**
     * Load and validate data from cfg sources
     * in proper order
     */
    this.loadSources();
    await this.reload();
    this.validate();

    /**
     * Merge from DI container
     * eg. when custom modules have config and dont want to use files
     * eg. in webpack environment
     */
    this.Container.resolve(Array.ofType('__configuration__')).forEach((c: IConfigLike) => {
      Object.keys(c).forEach((k) => {
        this.merge(k, c[`${k}`]);
      });
    });

    this.configure();
  }

  public async mergeSource(sType: Class<ConfigurationSource>) {
    const source = this.Container.resolve(sType);
    const sCfg = await source.Load(this);

    this.Sources.push(source);

    if (sCfg) {
      _.mergeWith(sCfg, mergeArrays);
    }
  }

  /**
   * Reloads configuration data
   */
  public async reload() {
    this.Config = {};

    for (const source of this.Sources) {
      const rCfg = await source.Load(this);

      if (rCfg) {
        _.mergeWith(this.Config, rCfg, mergeArrays);
      }
    }
  }

  protected loadSources() {
    this.Sources = this.Container.resolve<ConfigurationSource>(Array.ofType(ConfigurationSource), [
      this.RunApp,
      this.CustomConfigPaths,
      this.AppBaseDir,
    ]);

    // sort asc sources
    this.Sources.sort((a, b) => {
      return a.Order < b.Order ? -1 : a.Order > b.Order ? 1 : 0;
    });
  }

  protected validate() {
    this.ValidationSchemas.forEach((s) => {
      const config = this.get(s.$configurationModule);
      const result = this.Validator.validate(s, config);
      if (!result) {
        throw new InvalidConfiguration(
          'invalid configuration ! Check config files and restart app.',
          this.Validator.errors,
        );
      }
    });
  }

  protected initValidator() {
    this.Validator = new Ajv({
      logger: {
        log: (msg: string) => InternalLogger.info(msg, 'Configuration'),
        warn: (msg: string) => InternalLogger.warn(msg, 'Configuration'),
        error: (msg: string) => InternalLogger.error(msg, 'Configuration'),
      },

      // enable all errors on  validation, not only first one that occurred
      allErrors: true,

      // remove properties that are not defined in schema
      removeAdditional: true,

      // set default values if possible
      useDefaults: true,

      // The option coerceTypes allows you to have your data types coerced to the types specified in your schema type keywords
      coerceTypes: true,
    });

    // add $merge & $patch for json schema
    require('ajv-merge-patch')(this.Validator);

    // add common formats validation eg: date time
    require('ajv-formats')(this.Validator);

    // add keywords
    require('ajv-keywords')(this.Validator);

    // in strict mode ajv will throw when
    // unknown keyword in schema is met
    // we use $configurationModule keyword to identify
    // to match config module with config schema
    this.Validator.addKeyword('$configurationModule');

    /**
     * load all registered configuration json schemas
     * for config value validation
     */
    this.ValidationSchemas = this.Container.get<IConfigurationSchema>(Array.ofType('__configurationSchema__'), true);
  }

  protected dir(toJoin: string) {
    return normalize(join(resolve(this.AppBaseDir), toJoin));
  }

  /**
   * adds app dirs to system.dirs config
   */
  protected applyAppDirs() {
    if (!this.RunApp) {
      return;
    }

    for (const prop of Object.keys(this.get(['system', 'dirs'], []))) {
      this.get<string[]>(['system', 'dirs', prop]).push(this.dir(`/${this.RunApp}/${prop}`));
    }
  }

  /**
   * runs configuration func on files
   * eg. when you want to configure stuff at beginning eq. external libs
   */
  protected configure() {
    for (const prop of Object.keys(this.Config)) {
      const subconfig = this.Config[`${prop}`] as IConfigurable;

      if (subconfig.configure && typeof subconfig.configure === 'function') {
        subconfig.configure.apply(this);
      }
    }
  }
}
