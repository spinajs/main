/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { join, normalize, resolve } from 'path';
import Ajv from 'ajv';
import _ from 'lodash';
import { InternalLogger } from '@spinajs/internal-logger';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import {
  ConfigurationSource,
  IConfigLike,
  Configuration,
  ConfigurationOptions,
  IConfigurable,
  IConfigurationSchema,
  ConfigVarProtocol,
  ConfigVar,
} from '@spinajs/configuration-common';
import { Autoinject, Class, Container, Injectable, DI } from '@spinajs/di';

import { InvalidConfiguration } from './exception.js';
import { mapObject, mergeArrays, parseArgv, pickObjects, pickString } from './util.js';
import config from './config/configuration.js';
import './sources.js';

import { default as ajvMergePath } from 'ajv-merge-patch';
import { default as ajvFormats } from 'ajv-formats';
import { default as ajvKeywords } from 'ajv-keywords';

/**
 * HACK:
 * Becouse of ajv not supporting esm default exports we need to
 * check for default export module property and if not provided use module itself
 */

@Injectable(Configuration)
export class FrameworkConfiguration extends Configuration {
  /**
   * Apps configuration base dir, where to look for app config
   */
  public AppBaseDir = './';

  /**
   * Env passed via CLI args  ( in case if NODE_ENV var is not set )
   */
  public Env = 'development';

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

  /**
   * We ignore this error because ajv have problems with
   * commonjs / esm default exports
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected Validator: any;

  protected ValidationSchemas: IConfigurationSchema[];

  public get RootConfig() {
    return this.Config as IConfigLike;
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
    this.AppBaseDir = options?.appBaseDir ?? parseArgv('--apppath') ?? join(process.cwd(), '../apps/');
    this.Env = parseArgv('--env') ?? process.env.APP_ENV;
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

  public async resolve(): Promise<void> {
    if (!this.Container.hasRegistered(ConfigurationSource)) {
      throw new InvalidOperation(
        'No configuration sources configured. Please ensure that config module have any source to read from !',
      );
    }

    if (this.CustomConfigPaths) {
      // when using DI for resolving, options are injected and not type checked
      // double check for this
      if (!Array.isArray(this.CustomConfigPaths)) {
        throw new InvalidArgument(`ConfigurationConfigPaths should be an array`);
      }

      this.CustomConfigPaths.forEach((p) => {
        InternalLogger.trace(`Custom config path at: ${p}`, 'Configuration');
      });
    }

    if (this.RunApp) {
      InternalLogger.info(`Run app is ${this.RunApp}`, 'Configuration');
    }

    InternalLogger.info(`App base dir is ${this.AppBaseDir}`, 'Configuration');

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
    await this.load();

    this.validate();
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
  public async load() {
    this.Config = {};

    // add env variables to config
    const env = DI.get<NodeJS.ProcessEnv>('process.env');
    this.set('process.env', {
      ...process.env,
      ...env,
      APP_ENV: this.Env ?? env?.APP_ENV ?? process.env.NODE_ENV ?? 'development',
    });

    InternalLogger.info(`APP_ENV set to ${this.get<string>('process.env.APP_ENV')}`, 'Configuration');

    _.mergeWith(this.Config, this.onLoad(), mergeArrays);

    for (const source of this.Sources) {
      const rCfg = await source.Load(this);

      if (rCfg) {
        _.mergeWith(this.Config, rCfg, mergeArrays);
      }
    }

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

    // load config vars from various protocols
    await this.loadProtocolVars();

    /**
     * Each object in config replace with proxy to
     * handle protocols etc.
     */
    const proxyFunc = (obj: any) => {
      return new Proxy(obj, {
        get: (obj, prop) => {
          if (obj[prop] instanceof ConfigVar) {
            return obj[prop].get();
          }

          return obj[prop];
        },
      });
    };
    this.Config = proxyFunc(mapObject(this.Config, proxyFunc));
  }

  protected async loadProtocolVars() {
    const configProtocols = await DI.resolve(Array.ofType(ConfigVarProtocol));
    const reg = /^([a-zA-Z0-9\-]+:\/\/)+(.+)$/gm;

    const iterate = async (obj: { [key: string]: unknown }) => {
      if (!obj) {
        return;
      }

      if (Array.isArray(obj)) {
        obj.forEach((c) => iterate(c));
        return;
      }

      await Promise.all(
        pickString(obj).map(async ([key, val]) => {
          reg.lastIndex = 0;
          if (!reg.test(val)) {
            return;
          }

          reg.lastIndex = 0;
          const match = reg.exec(val);
          const protocol = configProtocols.find((p) => p.Protocol === match[1]);

          if (!protocol) {
            InternalLogger.warn(`Protocol ${match[2]} used in configuration is not registered.`, 'Configuration');
            return;
          }

          obj[key] = await protocol.getVar(match[2], this.Config);
        }),
      );

      await Promise.all(
        pickObjects(obj).map(async ([, val]) => {
          await iterate(val);
        }),
      );
    };

    await iterate(this.Config);
  }

  protected onLoad(): unknown {
    return null;
  }

  protected loadSources() {
    this.Sources = this.Container.resolve(Array.ofType(ConfigurationSource), [
      this.RunApp,
      this.CustomConfigPaths,
      this.AppBaseDir,
      this.Env,
    ]);

    // sort asc sources
    this.Sources.sort((a, b) => {
      return a.Order < b.Order ? -1 : a.Order > b.Order ? 1 : 0;
    });
  }

  protected validate() {
    this.ValidationSchemas.forEach((s) => {
      const config = this.get(s.$configurationModule);

      if (!config) {
        InternalLogger.warn(
          `Cannot validate configuration for module ${s.$configurationModule}, configuration is not set`,
          'Configuration',
        );

        return;
      }

      const result = this.Validator.validate(s, config);
      if (!result) {
        // @ts-ignore
        this.Validator.errors.forEach((ve) => {
          InternalLogger.error(
            'Invalid configuration ! Message: %s, path: %s, keyword: %s, schemaPath: %s, configuration module: %s',
            'Configuration',
            ve.message,
            ve.instancePath,
            ve.keyword,
            ve.schemaPath,
            s.$configurationModule,
          );
        });

        throw new InvalidConfiguration('Validation error', this.Validator.errors);
      }
    });
  }

  protected initValidator() {
    const options = {
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
    };

    // @ts-ignore
    if (Ajv.default) {
      // @ts-ignore
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      this.Validator = new Ajv.default(options);
    } else {
      // @ts-ignore
      this.Validator = new Ajv(options);
    }

    // add $merge & $patch for json schema
    ajvMergePath(this.Validator);

    // add common formats validation eg: date time
    ajvFormats.default(this.Validator);

    // add keywords
    ajvKeywords.default(this.Validator);

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

      if (!subconfig) {
        InternalLogger.warn(`Configuration for ${prop} not exists, check configuration file`, 'configuration');
        continue;
      }

      if (subconfig.configure && typeof subconfig.configure === 'function') {
        subconfig.configure.apply(this);
      }
    }
  }
}
