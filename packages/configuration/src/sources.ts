import { Autoinject, Container, IContainer, Injectable } from '@spinajs/di';
import glob from 'glob';
import { join, normalize, resolve } from 'path';
import { findBasePath, loadJsConfigFile, mergeConfig, type ArrayMerge } from './util.js';
import * as fs from 'fs';
import * as path from 'path';
import { InternalLogger } from '@spinajs/internal-logger';
import type { Manifest } from '@spinajs/manifest';
import { activeManifestOf, manifestPackageConfigFiles, manifestSettingsOf, projectConfigDirs } from './manifest-runtime.js';
import { Configuration, ConfigurationSource, IConfigLike, normalizeEnvironment } from '@spinajs/configuration-common';

/** A config file to load. `concat` marks a package's file, `replace` an app's; see `ConfigLayers`. */
export interface ConfigFile {
  file: string;
  arrays: ArrayMerge;
}

/**
 * The config files of a file source by layer. Packages sit strictly below the app: the configuration joins the
 * `packages` layers of adjacent file sources, whatever their format, and merges every `app` layer on top.
 */
export interface ConfigLayers {
  packages: IConfigLike;
  app: IConfigLike;
}

export interface LayeredConfigurationSource {
  LoadLayers(config: Configuration): Promise<ConfigLayers>;
}

export const isLayeredSource = (source: ConfigurationSource): source is ConfigurationSource & LayeredConfigurationSource => typeof (source as Partial<LayeredConfigurationSource>).LoadLayers === 'function';

/** The tree a layered source gives on its own, as a `Load()` result. */
export const flattenLayers = ({ packages, app }: ConfigLayers): IConfigLike => mergeConfig(packages, app, 'replace');

export abstract class BaseFileSource extends ConfigurationSource {
  /**
   * Configuration base dir, where to look for app config
   */
  public BaseDir = './';

  @Autoinject(Container)
  protected Container!: IContainer;

  /** The app's own config dirs, in merge order; they merge over every package config. */
  protected ProjectDirs: string[] = [];

  private commonDirsOverride: string[] | undefined;

  private packageDirs: string[] | undefined;

  /**
   * `node_modules/@spinajs/*\/lib/config` of every ancestor up to the workspace root, nearest first, plus the
   * WORKSPACE_ROOT_PATH one. Computed on first use instead of in the constructor, so it never runs with a manifest.
   *
   * Every ancestor with a node_modules is searched, mirroring how Node resolves: an app at <root>/packages/<app>
   * has its dependencies hoisted to <root>/node_modules, two levels up.
   */
  protected packageConfigDirs(): string[] {
    if (!this.packageDirs) {
      const packageGlob = 'node_modules/@spinajs/*/lib/config';
      this.packageDirs = BaseFileSource.nodeModulesAncestors(resolve(process.cwd())).map((dir) => normalize(join(dir, packageGlob)));

      if (process.env.WORKSPACE_ROOT_PATH) {
        this.packageDirs.push(normalize(join(resolve(process.env.WORKSPACE_ROOT_PATH), packageGlob)));
      }
    }
    return this.packageDirs;
  }

  /** Every dir globbed without a manifest, in merge order. Assignable by subclasses that own their dirs. */
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
   * Package configs ( http, fs, rbac, templates, ... ) locate their own assets as
   * `${WORKSPACE_ROOT_PATH ?? process.cwd()}/node_modules/@spinajs/<pkg>/lib/...`.
   * In a workspace, cwd is the app package but the dependencies are hoisted to the
   * repo root, so leaving this unset yields paths that do not exist - and an
   * fsNative provider CREATES its basePath, leaving empty dirs that shadow the real
   * package and break module resolution for everything importing it. Must run before
   * any config file is imported; an explicitly provided value always wins.
   */
  public static ensureWorkspaceRoot(): void {
    if (!process.env.WORKSPACE_ROOT_PATH) {
      const hoistingRoot = BaseFileSource.findHoistingRoot(resolve(process.cwd()));

      if (hoistingRoot) {
        InternalLogger.trace({ hoistingRoot }, 'WORKSPACE_ROOT_PATH not set, detected hoisting root at ${hoistingRoot}', 'Configuration');
        process.env.WORKSPACE_ROOT_PATH = hoistingRoot;
      }
    }
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

    BaseFileSource.ensureWorkspaceRoot();

    this.ProjectDirs = projectConfigDirs(process.cwd(), this.RunApp, this.appBaseDir, this.CustomConfigPaths);

    // try to find root folder with node_modules
    // on server environment
    const bPath = findBasePath(process.cwd());

    // if we cannot find node_modules folders and base path
    // assume that process working dir is base path
    // eg. on electron environment
    this.BasePath = bPath === null ? process.cwd() : bPath;
  }

  /** The manifest whose package config files replace the package dir globs, when the effective mode uses one. */
  protected activeManifest(): Manifest | undefined {
    return this.Container ? activeManifestOf(this.Container) : undefined;
  }

  /**
   * Config files matching `extension`, in merge order. With a manifest the package config files come from it, in
   * the place and order the package dir globs list them; everything else is the same.
   */
  protected configFiles(extension: string): ConfigFile[] {
    const globDir = (dir: string, arrays: ArrayMerge): ConfigFile[] =>
      glob.sync(path.join(path.isAbsolute(dir) ? dir : join(this.BasePath, dir), `/**/${extension}`).replace(/\\/g, '/')).map((file) => ({ file, arrays }));

    const manifest = this.commonDirsOverride ? undefined : this.activeManifest();
    if (!manifest) {
      const packageDirs = new Set(this.packageConfigDirs());
      return this.CommonDirs.flatMap((dir) => globDir(dir, packageDirs.has(dir) ? 'concat' : 'replace'));
    }

    const mode = this.Container ? manifestSettingsOf(this.Container)?.mode : undefined;
    const listed = manifestPackageConfigFiles(manifest, extension, process.cwd(), mode).map((file) => ({ file, arrays: 'concat' as const }));
    return [...listed, ...this.ProjectDirs.flatMap((dir) => globDir(dir, 'replace'))];
  }

  private resolvedFiles(extension: string): ConfigFile[] {
    return this.configFiles(extension)
      // Overlapping globs (ancestors and WORKSPACE_ROOT_PATH) list the same path twice: the first listing wins.
      .map((f) => ({ ...f, file: normalize(resolve(f.file)) }))
      .filter((f, index, self) => self.findIndex((o) => o.file === f.file) === index)
      // A workspace package's own lib/config is also reached through its node_modules symlink. The last place a
      // file is reached wins, so a project dir searched later still merges over the package globs.
      .map((f) => ({ ...f, file: fs.realpathSync(f.file) }))
      .filter((f, index, self) => self.findLastIndex((o) => o.file === f.file) === index);
  }

  private async mergeFiles(extension: string, callback: (file: string) => Promise<IConfigLike>, target: (file: ConfigFile) => IConfigLike): Promise<void> {
    const files = this.resolvedFiles(extension);
    const result = await Promise.all<IConfigLike>(files.map((f) => callback(f.file)));

    result.forEach((c, i) => {
      if (c !== undefined && c !== null) {
        mergeConfig(target(files[i]), c.default ?? c, files[i].arrays);
      }
    });
  }

  /** Loads the config files matching `extension` into one tree, in order. One pass; `loadLayers()` keeps the layers apart. */
  protected async load(extension: string, callback: (file: string) => Promise<IConfigLike>): Promise<IConfigLike> {
    const config: IConfigLike = {};
    await this.mergeFiles(extension, callback, () => config);
    return config;
  }

  /** Loads the config files matching `extensions`, one pass after the other, each into its layer. */
  protected async loadLayers(extensions: string[], callback: (file: string) => Promise<IConfigLike>): Promise<ConfigLayers> {
    const layers: ConfigLayers = { packages: {}, app: {} };
    for (const extension of extensions) {
      await this.mergeFiles(extension, callback, (f) => (f.arrays === 'concat' ? layers.packages : layers.app));
    }
    return layers;
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
export class JsFileSource extends BaseFileSource implements LayeredConfigurationSource {
  public LoadLayers(config: Configuration): Promise<ConfigLayers> {
    return this.loadLayers(['!(*.*).{cjs,js}', `*.${this.getEnvironment(config)}.{cjs,js}`], loadJsConfigFile);
  }

  public async Load(config: Configuration): Promise<IConfigLike> {
    return flattenLayers(await this.LoadLayers(config));
  }
}

@Injectable(ConfigurationSource)
export class JsonFileSource extends BaseFileSource implements LayeredConfigurationSource {
  public async Load(config: Configuration): Promise<IConfigLike> {
    return flattenLayers(await this.LoadLayers(config));
  }

  public LoadLayers(config: Configuration): Promise<ConfigLayers> {
    return this.loadLayers(['!(*.*).json', `*.${this.getEnvironment(config)}.json`], _load);

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
