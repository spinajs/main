/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, DI } from '@spinajs/di';
import glob from 'glob';
import { default as _ } from 'lodash';
import { join, normalize, resolve } from 'path';
import { findBasePath, mergeArrays } from './util.js';
import * as fs from 'fs';
import * as path from 'path';
import { InternalLogger } from '@spinajs/internal-logger';
import { ConfigurationSource } from '@spinajs/configuration-common';

export abstract class BaseFileSource extends ConfigurationSource {
  /**
   * Configuration base dir, where to look for app config
   */
  public BaseDir = './';

  protected CommonDirs = [
    // for tests, in src dir
    normalize(join(resolve(process.cwd()), 'src', '/config')),

    // other @spinajs modules paths
    normalize(join(resolve(process.cwd()), 'node_modules/@spinajs/*/lib/config')),

    // project paths - last to allow overwrite @spinajs conf
    normalize(join(resolve(process.cwd()), 'src', 'lib/config')),
    normalize(join(resolve(process.cwd()), 'src', 'dist/config')),
    normalize(join(resolve(process.cwd()), 'src', 'build/config')),
    normalize(join(resolve(process.cwd()), 'src', 'config')),
  ];

  protected BasePath = '';

  public get Order() {
    return 1;
  }

  constructor(protected RunApp?: string, protected CustomConfigPaths?: string[], protected appBaseDir?: string) {
    super();

    // try to find root folder with node_modules
    // on server environment
    const bPath = findBasePath(process.cwd());

    // if we cannot find node_modules folders and base path
    // assume that process working dir is base path
    // eg. on electron environment
    this.BasePath = bPath === null ? process.cwd() : bPath;

    if (this.RunApp) {
      this.CommonDirs = this.CommonDirs.concat([join(this.appBaseDir, `/${this.RunApp}/config`)]);
    }

    if (this.CustomConfigPaths) {
      this.CommonDirs = this.CommonDirs.concat(this.CustomConfigPaths);
    }
  }

  protected async load(extension: string, callback: (file: string) => Promise<any>) {
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
      .filter((f: string, index: number, self: any[]) => self.indexOf(f) === index)
      .map(callback);

    const result = await Promise.all(toResolve);

    result
      .filter((v: any) => v !== null)
      // load & merge configs
      .map((c: any) => _.mergeWith(config, c.default ?? c, mergeArrays));

    return config;
  }
}

@Injectable(ConfigurationSource)
export class JsFileSource extends BaseFileSource {
  public async Load(): Promise<any> {
    const common = await this.load('!(*.dev|*.prod).{cjs,js}', _load);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const dEnv = DI.get<any>('process.env') ?? process.env;
    const fExt = dEnv.NODE_ENV && dEnv.NODE_ENV === 'development' ? '*.dev.{cjs,js}' : '*.prod.{cjs,js}';
    const env = await this.load(fExt, _load);
    return  _.mergeWith(common, env, mergeArrays);

    async function _load(file: string) {
      try {
        InternalLogger.trace(`Trying to load file ${file}`, 'Configuration');

        // eslint-disable -next-line security/detect-non-literal-require
        const res = await import(`file://${file}`);
        return res.default;
      } catch (err) {
        InternalLogger.error(err, `error loading configuration file ${file}`);
        return null;
      }
    }
  }
}

@Injectable(ConfigurationSource)
export class JsonFileSource extends BaseFileSource {
  public async Load(): Promise<any> {
    const common = await this.load('!(*.dev|*.prod).json', _load);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const dEnv = DI.get<any>('process.env') ?? process.env;
    const fExt = dEnv.NODE_ENV && dEnv.NODE_ENV === 'development' ? '*.dev.json' : '*.prod.json';
    const env = await this.load(fExt, _load);
    return _.mergeWith(common, env, mergeArrays);

    function _load(file: string) {
      try {
        InternalLogger.trace(`Trying to load file ${file}`, 'Configuration');

        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch (err) {
        console.error(`error loading configuration file ${file}, reasoun: ${(err as Error).message}`);
        return null;
      }
    }
  }
}
