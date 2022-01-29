import { Autoinject, Container, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { join, normalize, resolve } from 'path';
import { ConfigurationSource } from './sources';
import { Configuration, ConfigurationOptions } from './types';
import { parseArgv } from './util';
import * as _ from 'lodash';
import Ajv from 'ajv';
import { InvalidConfiguration } from './exception';

@Injectable(Configuration)
export class FrameworkConfiguration extends Configuration {
  /**
   * Apps configuration base dir, where to look for app config
   */
  public AppBaseDir: string = './';

  /**
   * Current running app name
   */
  public RunApp: string = '';

  /**
   * Loaded & merged configuration
   */
  protected Config: any = {};

  protected CustomConfigPaths: string[];

  protected Sources: ConfigurationSource[];

  @Autoinject()
  protected Container: Container;

  /**
   *
   * @param app application name, pass it when you run in application mode
   * @param baseDir configuration base dir, where to look for application configs
   * @param cfgCustomPaths custom cfg paths eg. to load config from non standard folders ( usefull in tests )
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
   * @returns { T | undefined }
   */
  public get<T>(path: string[] | string, defaultValue?: T): T {
    return _.get(this.Config, path, defaultValue);
  }

  /**
   * Sets at given path configuration value. Use when you want to override config
   * loaded from files programatically
   *
   * @param path config path
   * @param value value to set
   */
  public set(path: string[] | string, value: any) {
    this.Config = _.set(this.Config, path, value);
  }

  public async resolveAsync(): Promise<void> {
    if (!this.Container.hasRegistered(ConfigurationSource)) {
      throw new InvalidOperation(
        'No configuration sources configured. Please ensure that config module have any source to read from !',
      );
    }

    this.Sources = await this.Container.resolve(Array.ofType(ConfigurationSource), [
      this.RunApp,
      this.CustomConfigPaths,
      this.AppBaseDir,
    ]);

    await Promise.all(this.Sources.map((s) => s.Load())).then((result) => {
      result.map((c) => _.merge(this.Config, c));
    });

    this.validateConfig();
    this.applyAppDirs();
    this.configure();
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

  protected validateConfig() {
    const validator = new Ajv({
      // logger: {
      //   // log: (msg: string) => {},
      //   // warn: (msg: string) => {},
      //   // error: (msg: string) => {},
      // },

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
    require('ajv-merge-patch')(validator);

    // add common formats validation eg: date time
    require('ajv-formats')(validator);

    // add keywords
    require('ajv-keywords')(validator);

    const schemas = this.Container.get<any[]>('__configurationSchema__', true);

    Object.keys(this.Config).forEach((k) => {
      const schema = schemas.find((x) => x.$configurationModule === k);

      if (schema) {
        if (!validator.validate(schema, this.Config[k])) {
          throw new InvalidConfiguration(
            'invalid configuration ! Check config files and restart app.',
            validator.errors,
          );
        }
      }
    });
  }

  /**
   * runs configuration func on files
   * eg. when you want to configure stuff at beginning eq. external libs
   */
  protected configure() {
    for (const prop of Object.keys(this.Config)) {
      const subconfig = this.Config[prop];

      if (_.isFunction(subconfig.configure)) {
        subconfig.configure.apply(this);
      }
    }
  }
}
