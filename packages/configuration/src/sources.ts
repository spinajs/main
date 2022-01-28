import { Injectable } from '@spinajs/di';
import { glob } from 'glob';
import _ = require('lodash');
import { join, normalize, resolve } from 'path';
import { findBasePath, uncache } from './util';
import * as fs from 'fs';
import * as path from 'path';
import { Log } from '@spinajs/log/lib/log';

function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export abstract class ConfigurationSource {
  public abstract Load(): Promise<any>;
}

export abstract class BaseFileSource extends ConfigurationSource {
  /**
   * Configuration base dir, where to look for app config
   */
  public BaseDir: string = './';

  protected CommonDirs = [
    // this module path
    normalize(join(resolve(__dirname), '/../config')),

    // for tests, in src dir
    normalize(join(resolve(__dirname), '/config')),

    // other @spinajs modules paths
    'node_modules/@spinajs/*/lib/config',

    // project paths - last to allow overwrite @spinajs conf
    'lib/config',
    'dist/config',
    'build/config',
    'config',
  ];

  protected BasePath: string = '';

  constructor(protected RunApp?: string, protected CustomConfigPaths?: string[], protected appBaseDir?: string) {
    super();

    this.BasePath = findBasePath(process.cwd());
  }

  protected load(extension: string, callback: (file: string) => any) {
    const config = {};

    if (this.RunApp) {
      this.CommonDirs = this.CommonDirs.concat([join(this.appBaseDir, `/${this.RunApp}/config`)]);
    }

    if (this.CustomConfigPaths) {
      this.CommonDirs = this.CommonDirs.concat(this.CustomConfigPaths);
    }

    this.CommonDirs.map((f) => (path.isAbsolute(f) ? f : join(this.BasePath, f)))
      // get all config files
      .map((d) => glob.sync(path.join(d, `/**/${extension}`)))
      // flatten files
      .reduce((prev, current) => {
        return prev.concat(_.flattenDeep(current));
      }, [])
      // normalize & resolve paths to be sure
      .map((f: string) => normalize(resolve(f)))
      .map(callback)
      .filter((v: any) => v !== null)
      // load & merge configs
      .map((c: any) => _.mergeWith(config, c.default ?? c, mergeArrays));

    return config;
  }
}

@Injectable(ConfigurationSource)
export class JsFileSource extends BaseFileSource {
  public async Load(): Promise<any> {
    const common = this.load('!(*.dev|*.prod).js', _load);

    if (process.env.NODE_ENV) {
      if (process.env.NODE_ENV === 'development') {
        return _.mergeWith(common, this.load('*.dev.js', _load), mergeArrays);
      } else if (process.env.NODE_ENV === 'production') {
        return _.mergeWith(common, this.load('*.prod.js', _load), mergeArrays);
      }
    }

    return common;

    function _load(file: string) {
      Log.trace(`Trying to load file ${file}`, 'Configuration');

      uncache(file);
      return require(file);
    }
  }
}

@Injectable(ConfigurationSource)
export class JsonFileSource extends BaseFileSource {
  public async Load(): Promise<any> {
    const common = this.load('!(*.dev|*.prod).json', _load);

    if (process.env.NODE_ENV) {
      if (process.env.NODE_ENV === 'development') {
        return _.mergeWith(common, this.load('*.dev.json', _load), mergeArrays);
      } else if (process.env.NODE_ENV === 'production') {
        return _.mergeWith(common, this.load('*.prod.json', _load), mergeArrays);
      }
    }

    return common;

    function _load(file: string) {
      try {
        Log.trace(`Trying to load file ${file}`, 'Configuration');

        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch (err) {
        return null;
      }
    }
  }
}
