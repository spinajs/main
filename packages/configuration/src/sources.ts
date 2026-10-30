import { Autoinject, Container, IContainer, Injectable } from '@spinajs/di';
import glob from 'glob';
import { default as _ } from 'lodash';
import { join, normalize, resolve } from 'path';
import { findBasePath, loadJsConfigFile, mergeArrays } from './util.js';
import * as fs from 'fs';
import * as path from 'path';
import { InternalLogger } from '@spinajs/internal-logger';
import { manifestOf } from './manifest-source.js';
import { Configuration, ConfigurationSource, IConfigLike, normalizeEnvironment } from '@spinajs/configuration-common';

export abstract class BaseFileSource extends ConfigurationSource {
  /**
   * Configuration base dir, where to look for app config
   */
  public BaseDir = './';

  @Autoinject(Container)
  protected Container!: IContainer;

  protected ProjectDirs: string[] = [];

  private commonDirsOverride: string[] | undefined;

  /**
   * `node_modules/@spinajs/*\/lib/config` of every ancestor up to the workspace root, nearest first, plus the
   * WORKSPACE_ROOT_PATH one. Computed on every read, not in the constructor: when ManifestConfigurationSource ran
   * first the manifest already named every package defaults file and the walk is skipped.
   */
  protected packageConfigDirs(): string[] {
    this.ensureWorkspaceRoot();

    if (this.manifestRegistered()) {
      return [];
    }

    const packageGlob = 'node_modules/@spinajs/*/lib/config';
    const dirs = BaseFileSource.nodeModulesAncestors(resolve(process.cwd())).map((dir) => normalize(join(dir, packageGlob)));

    if (process.env.WORKSPACE_ROOT_PATH) {
      dirs.push(normalize(join(resolve(process.env.WORKSPACE_ROOT_PATH), packageGlob)));
    }

    return dirs;
  }

  private ensureWorkspaceRoot(): void {
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
        InternalLogger.trace({ hoistingRoot }, 'WORKSPACE_ROOT_PATH not set, detected hoisting root at ${hoistingRoot}', 'Configuration');
        process.env.WORKSPACE_ROOT_PATH = hoistingRoot;
      }
    }
  }

  private manifestRegistered(): boolean {
    try {
      return this.Container !== undefined && manifestOf(this.Container) !== undefined;
    } catch {
      return false;
    }
  }

  /** Package dirs first, project dirs after, so the project wins on merge. Assignable by subclasses that own their dirs. */
  protected get CommonDirs(): string[] {
    return this.commonDirsOverride ?? [...this.packageConfigDirs(), ...this.ProjectDirs];
  }

  protected set CommonDirs(dirs: string[]) {
    this.commonDirsOverride = dirs;
  }

  protected BasePath = '';

  public get Order() {
    return 1;
  }

  /**
   * Walks from `startDir` up, returning every directory that contains a `node_modules`
   * folder, nearest first. Used to locate `@spinajs` package configs wherever the
   * package manager happened to hoist them.
   *
   * The walk ends at the nearest workspace root: anything above it belongs to another
   * project. A checkout nested in another one ( a git worktree under the main checkout )
   * would otherwise load the outer checkout's package configs, and with them a second
   * `@spinajs/di`. Without a workspace root it goes up to the filesystem root.
   */
  protected static nodeModulesAncestors(startDir: string): string[] {
    const found: string[] = [];
    let current = startDir;

    for (;;) {
      if (fs.existsSync(path.join(current, 'node_modules'))) {
        found.push(current);
      }

      const parent = path.dirname(current);
      if (parent === current || BaseFileSource.isWorkspaceRoot(current)) {
        return found;
      }

      current = parent;
    }
  }

  protected static isWorkspaceRoot(dir: string): boolean {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return true;
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { workspaces?: unknown };
      return manifest.workspaces !== undefined;
    } catch {
      return false;
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

    // project paths - after the package dirs, so an app config overrides a package default
    this.ProjectDirs = [
      normalize(join(resolve(process.cwd()), 'src', '/config')),
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

      if(this.appBaseDir) {
        this.ProjectDirs.push(join(this.appBaseDir, `/${this.RunApp}/config`));
      }

      // common dirs for app where config resides
      this.ProjectDirs.push(join(process.cwd(), `/apps/${this.RunApp}/config`));
      this.ProjectDirs.push(join(process.cwd(), `/dist/apps/${this.RunApp}/config`));
      this.ProjectDirs.push(join(process.cwd(), `/lib/apps/${this.RunApp}/config`));
      this.ProjectDirs.push(join(process.cwd(), `/build/apps/${this.RunApp}/config`));
    }

    if (this.CustomConfigPaths) {
      this.ProjectDirs.push(...this.CustomConfigPaths);
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
      // Overlapping globs (ancestors and WORKSPACE_ROOT_PATH) list the same path twice: the first listing wins.
      .map((f: string) => normalize(resolve(f)))
      .filter((f: string, index: number, self: string[]) => self.indexOf(f) === index)
      // A workspace package's own lib/config is also reached through its node_modules symlink. The last place a
      // file is reached wins, so a project dir searched later still merges over the package globs.
      .map((f: string) => fs.realpathSync(f))
      .filter((f: string, index: number, self: string[]) => self.lastIndexOf(f) === index)
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
    const common = await this.load(`!(*.*).{cjs,js}`, loadJsConfigFile);
    const fExt = `*.${env}.{cjs,js}`;
    const cfg = (await this.load(fExt, loadJsConfigFile)) as IConfigLike;

    return _.mergeWith(common, cfg, mergeArrays);
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
        InternalLogger.trace({ file }, 'Trying to load file ${file}', 'Configuration');

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
        InternalLogger.error({ error: err, file }, 'error loading configuration file ${file}', 'configuration');
        return Promise.resolve({} as IConfigLike);
      }
    } 
  }
}
