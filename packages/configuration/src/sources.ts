import { Injectable, DI } from '@spinajs/di';
import glob from 'glob';
import { default as _ } from 'lodash';
import { join, normalize, resolve } from 'path';
import { findBasePath, mergeArrays } from './util.js';
import * as fs from 'fs';
import * as path from 'path';
import { InternalLogger } from '@spinajs/internal-logger';
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration-common';

interface IDynamicImportType {
  default: unknown;
}

export abstract class BaseFileSource extends ConfigurationSource {
  /**
   * Configuration base dir, where to look for app config
   */
  public BaseDir = './';

  protected CommonDirs: string[] = [];

  protected BasePath = '';

  public get Order() {
    return 1;
  }

  constructor(
    protected RunApp?: string,
    protected CustomConfigPaths?: string[],
    protected appBaseDir?: string,
    protected Env?: string,
  ) {
    super();

    const isESMMode = DI.get<boolean>('__esmMode__');

    this.CommonDirs = [
      // for tests, in src dir
      normalize(join(resolve(process.cwd()), 'src', '/config')),

      // other @spinajs modules paths
      normalize(
        join(
          resolve(process.cwd()),
          isESMMode ? 'node_modules/@spinajs/*/lib/mjs/config' : 'node_modules/@spinajs/*/lib/cjs/config',
        ),
      ),

      // if we run from local app dir
      normalize(
        join(
          resolve(process.cwd()),
          '../',
          isESMMode ? 'node_modules/@spinajs/*/lib/mjs/config' : 'node_modules/@spinajs/*/lib/cjs/config',
        ),
      ),

      // project paths - last to allow overwrite @spinajs conf
      normalize(join(resolve(process.cwd()), 'lib/config')),
      normalize(join(resolve(process.cwd()), 'dist/config')),
      normalize(join(resolve(process.cwd()), 'build/config')),
      normalize(join(resolve(process.cwd()), 'config')),
    ];

    // try to find root folder with node_modules
    // on server environment
    const bPath = findBasePath(process.cwd());

    // if we cannot find node_modules folders and base path
    // assume that process working dir is base path
    // eg. on electron environment
    this.BasePath = bPath === null ? process.cwd() : bPath;

    if (this.RunApp) {
      this.CommonDirs = this.CommonDirs.concat([join(this.appBaseDir, `/${this.RunApp}/config`)]);

      // common dirs for app where config resides
      this.CommonDirs = this.CommonDirs.concat([join(process.cwd(), `/apps/${this.RunApp}/config`)]);
      this.CommonDirs = this.CommonDirs.concat([join(process.cwd(), `/dist/apps/${this.RunApp}/config`)]);
      this.CommonDirs = this.CommonDirs.concat([join(process.cwd(), `/lib/apps/${this.RunApp}/config`)]);
      this.CommonDirs = this.CommonDirs.concat([join(process.cwd(), `/build/apps/${this.RunApp}/config`)]);
    }

    if (this.CustomConfigPaths) {
      this.CommonDirs = this.CommonDirs.concat(this.CustomConfigPaths);
    }
  }

  protected async load(extension: string, callback: (file: string) => Promise<unknown>) {
    const config = {};

    const toResolve = this.CommonDirs.map((f) => (path.isAbsolute(f) ? f : join(this.BasePath, f)))
      // get all config files
      .map((d) => {
        return glob.sync(path.join(d, `/**/${extension}`).replace(/\\/g, '/'));
      })
      // flatten files
      .reduce((prev, current) => {
        return prev.concat(_.flattenDeep(current));
      }, [])
      // normalize & resolve paths to be sure
      .map((f: string) => normalize(resolve(f)))
      .filter((f: string, index: number, self: unknown[]) => self.indexOf(f) === index)
      .map(callback);

    const result = await Promise.all<IDynamicImportType[] | unknown[]>(toResolve);

    result
      .filter((v: IDynamicImportType) => v !== undefined && v !== null)
      // load & merge configs
      .map((c: IDynamicImportType) => _.mergeWith(config, c.default ?? c, mergeArrays));

    return config;
  }

  protected getEnvironment(config: Configuration) {
    let env = config.get<string>('process.env.APP_ENV', undefined) ?? this.Env ?? 'production';
    switch (env) {
      case 'dev':
      case 'development':
        return 'dev';
      case 'prod':
      case 'production':
        return 'prod';
      default:
        return env;
    }
  }
}

@Injectable(ConfigurationSource)
export class JsFileSource extends BaseFileSource {
  public async Load(config: Configuration): Promise<IConfigLike> {
    const env = this.getEnvironment(config);
    const common = await this.load(`!(*.*).{cjs,js}`, _load);
    const fExt = `*.${env}.{cjs,js}`;
    let cfg = (await this.load(fExt, _load)) as IConfigLike;

    return _.mergeWith(common, cfg, mergeArrays);

    async function _load(file: string) {
      try {
        InternalLogger.trace(`Trying to load file ${file}`, 'Configuration');

        let cfg = (await DI.__spinajs_require__(file)) as IConfigLike;
        // execute config func before merge with rest of configuration
        if (typeof cfg.onConfigLoad === 'function') {
          cfg = await cfg.onConfigLoad(cfg);
        }

        // all root props gets file info saved
        // for debugging purposes
        for (let k in cfg) {
          if (typeof cfg[k] === 'object' && !Array.isArray(cfg[k]) && cfg[k] !== null) {
            (cfg[k] as any).__file__ = [file];
          }
        }

        return cfg;
      } catch (err) {
        InternalLogger.error(err as Error, `error loading configuration file ${file}`, 'configuration');
        return null;
      }
    }
  }
}

@Injectable(ConfigurationSource)
export class JsonFileSource extends BaseFileSource {
  public async Load(config: Configuration): Promise<IConfigLike> {
    const env = this.getEnvironment(config);
    const common = await this.load(`!(*.*).json`, _load);
    const fExt = `*.${env}.json`;
    const cfg = await this.load(fExt, _load);
    return _.mergeWith(common, cfg, mergeArrays) as IConfigLike;

    function _load(file: string) {
      try {
        InternalLogger.trace(`Trying to load file ${file}`, 'Configuration');

        const cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) as any;

        // all root props gets file info saved
        // for debugging purposes
        for (let k in cfg) {
          if (typeof cfg[k] === 'object' && !Array.isArray(cfg[k]) && cfg[k] !== null) {
            (cfg[k] as any).__file__ = [file];
          }
        }
        return Promise.resolve(cfg);
      } catch (err) {
        console.error(`error loading configuration file ${file}, reasoun: ${(err as Error).message}`);
        return null;
      }
    }
  }
}
