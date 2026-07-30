import { Injectable, DI } from '@spinajs/di';
import glob from 'glob';
import { default as _ } from 'lodash';
import { join, normalize, resolve } from 'path';
import { findBasePath, mergeArrays } from './util.js';
import * as fs from 'fs';
import * as path from 'path';
import { InternalLogger } from '@spinajs/internal-logger';
import { Configuration, ConfigurationSource, IConfigLike, normalizeEnvironment } from '@spinajs/configuration-common';

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

  /**
   * Walks from `startDir` up to the filesystem root, returning every directory that
   * contains a `node_modules` folder, nearest first. Used to locate `@spinajs`
   * package configs wherever the package manager happened to hoist them.
   */
  protected static nodeModulesAncestors(startDir: string): string[] {
    const found: string[] = [];
    let current = startDir;

    for (;;) {
      if (fs.existsSync(path.join(current, 'node_modules'))) {
        found.push(current);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return found;
      }

      current = parent;
    }
  }

  /**
   * Nearest ancestor of `startDir` whose `node_modules/@spinajs` actually holds
   * packages, i.e. where the package manager hoisted them to.
   *
   * The directory must be non-empty on purpose: a workspace member often has its own
   * empty `node_modules/@spinajs` left over from linking, and picking that would be
   * worse than picking nothing.
   */
  protected static findHoistingRoot(startDir: string): string | null {
    for (const dir of BaseFileSource.nodeModulesAncestors(startDir)) {
      const scopeDir = path.join(dir, 'node_modules', '@spinajs');

      try {
        if (fs.readdirSync(scopeDir).length > 0) {
          return dir;
        }
      } catch {
        // no @spinajs scope here - keep walking up
      }
    }

    return null;
  }

  constructor(
    protected RunApp?: string,
    protected CustomConfigPaths?: string[],
    protected appBaseDir?: string,
    protected Env?: string,
  ) {
    super();

    const isESMMode = DI.get<boolean>('__esmMode__');

    // Package configs ( http, fs, rbac, templates, ... ) locate their own assets as
    // `${WORKSPACE_ROOT_PATH ?? process.cwd()}/node_modules/@spinajs/<pkg>/lib/...`.
    // In a workspace, cwd is the app package but the dependencies are hoisted to the
    // repo root, so leaving this unset yields paths that do not exist - and an
    // fsNative provider CREATES its basePath, leaving empty dirs that shadow the real
    // package and break module resolution for everything importing it. Detect the
    // root once here so every package config resolves correctly; an explicitly
    // provided value always wins.
    if (!process.env.WORKSPACE_ROOT_PATH) {
      const hoistingRoot = BaseFileSource.findHoistingRoot(resolve(process.cwd()));

      if (hoistingRoot) {
        InternalLogger.trace(`WORKSPACE_ROOT_PATH not set, detected hoisting root at ${hoistingRoot}`, 'Configuration');
        process.env.WORKSPACE_ROOT_PATH = hoistingRoot;
      }
    }

    const spinajsConfigGlob = isESMMode ? 'node_modules/@spinajs/*/lib/mjs/config' : 'node_modules/@spinajs/*/lib/cjs/config';

    this.CommonDirs = [
      // for tests, in src dir
      normalize(join(resolve(process.cwd()), 'src', '/config')),

      // other @spinajs modules paths
      //
      // Every ancestor that actually has a node_modules is searched, nearest first,
      // mirroring how Node itself resolves. Checking only cwd and its parent broke
      // npm/yarn workspaces: an app at <root>/packages/<app> has its dependencies
      // hoisted to <root>/node_modules, two levels up, so none of the @spinajs
      // package configs were ever found. That failed late and cryptically - the
      // http config never loaded, so controllers could not resolve
      // `__fs_controller_cache__` and the server never started - and it was only
      // masked by setting WORKSPACE_ROOT_PATH by hand.
      ...BaseFileSource.nodeModulesAncestors(resolve(process.cwd())).map((dir) => normalize(join(dir, spinajsConfigGlob))),
    ];

    
    if (process.env.WORKSPACE_ROOT_PATH) {
      this.CommonDirs = this.CommonDirs.concat([
        
        // for monorepo setups
        normalize(
          join(
            resolve(process.env.WORKSPACE_ROOT_PATH),
            isESMMode ? 'node_modules/@spinajs/*/lib/mjs/config' : 'node_modules/@spinajs/*/lib/cjs/config',
          ),
        ),
      ]);
    }

       // project paths - last to allow overwrite @spinajs conf
     this.CommonDirs.push(normalize(join(resolve(process.cwd()), 'lib/config')));
     this.CommonDirs.push(normalize(join(resolve(process.cwd()), 'dist/config')));
     this.CommonDirs.push(normalize(join(resolve(process.cwd()), 'build/config')));
     this.CommonDirs.push(normalize(join(resolve(process.cwd()), 'config')));

    // try to find root folder with node_modules
    // on server environment
    const bPath = findBasePath(process.cwd());

    // if we cannot find node_modules folders and base path
    // assume that process working dir is base path
    // eg. on electron environment
    this.BasePath = bPath === null ? process.cwd() : bPath;

    if (this.RunApp) {

      if(this.appBaseDir) {
        this.CommonDirs = this.CommonDirs.concat([join(this.appBaseDir, `/${this.RunApp}/config`)]);
      }

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

  protected async load(extension: string, callback: (file: string) => Promise<IConfigLike>) {
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

    const result = await Promise.all<IConfigLike>(toResolve);

    result
      .filter((v: IConfigLike) => v !== undefined && v !== null)
      // load & merge configs
      .map((c: IConfigLike) => _.mergeWith(config, c.default ?? c, mergeArrays));

    return config;
  }

  /**
   * Delegates to `normalizeEnvironment` so config file loading and migration file loading can
   * never disagree about what an environment name means. Signature kept - subclasses override it.
   */
  protected getEnvironment(config: Configuration) {
    return normalizeEnvironment(config.get<string>('process.env.APP_ENV', undefined) ?? this.Env);
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
          cfg = (await cfg.onConfigLoad(cfg))!;
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
        return {} as IConfigLike;      }
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
        InternalLogger.error(err as Error, `error loading configuration file ${file}`, 'configuration');
        return Promise.resolve({} as IConfigLike);
      }
    } 
  }
}
