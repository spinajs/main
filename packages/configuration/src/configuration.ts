/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { join, normalize, resolve } from 'path';
import Ajv, { ErrorObject } from 'ajv';
import _ from 'lodash';
import { InternalLogger } from '@spinajs/internal-logger';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import {
  ConfigurationSource,
  IConfigLike,
  ConfigPath,
  ConfigPaths,
  Configuration,
  ConfigurationOptions,
  IConfigurable,
  IConfigurationSchema,
  ConfigVarProtocol,
  ConfigVar,
  CONFIGURATION_SOURCES,
  CONFIGURATION_SCHEMA,
} from '@spinajs/configuration-common';
import { Autoinject, Class, Container, IContainer, Injectable } from '@spinajs/di';

import { ConfigurationViolation, InvalidConfiguration } from './exception.js';
import { mapObject, mergeConfig, mergeInto, parseArgv, pickObjects, pickString, sameSchema, schemaNameOf } from './util.js';
import config, { buildEnvironmentFlags } from './config/configuration.js';
import { isLayeredSource, type ConfigLayers } from './sources.js';
import { MANIFEST_SETTINGS } from './manifest-runtime.js';

import { default as ajvMergePath } from 'ajv-merge-patch';
import { default as ajvFormats } from 'ajv-formats';
import { default as ajvKeywords } from 'ajv-keywords';

const PROTOCOL_REGEXP = /^([a-zA-Z0-9\-]+:\/\/)+(.+)$/gm;
const COMMON_WEB_PROTOCOLS = ['http://', 'https://', 'ws://', 'wss://', 'ftp://', 'ftps://', 'file://', 'data://', 'blob://', 'mailto:'];

// A Configuration whose check ran but which DI has not cached yet (the microtasks after resolve() returns), by container.
const CHECKED = new WeakMap<IContainer, FrameworkConfiguration>();

// The target of each lazy-var proxy load() builds, by proxy: copying a proxy property by property would load every var.
const LAZY_TARGETS = new WeakMap<object, object>();

// Set while Ajv validates the stored value in place: it writes coerced values back through the proxies.
let keepUnresolvedVars = false;

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

// _.set skips these keys, but _.get resolves them, so merge() into `__proto__` would write to Object.prototype.
function assertSafePath(path: string[] | string) {
  const unsafe = _.toPath(path).find((s) => UNSAFE_PATH_SEGMENTS.has(s));
  if (unsafe !== undefined) throw new InvalidArgument(`Configuration path '${_.toPath(path).join('.')}' contains the reserved segment '${unsafe}'`);
}

const isUnresolved = (v: unknown) => v instanceof ConfigVar && (v.get() ?? null) === null;

function withLazyVars<T extends object>(obj: T): T {
  const proxy = new Proxy(obj, {
    get: (o: any, prop) => (o[prop] instanceof ConfigVar ? o[prop].get() : o[prop]),
    set: (o: any, prop, value) => {
      // A var that is not ready yet reads as null; its coercion ('' for a string) must not replace it for good.
      if (!(keepUnresolvedVars && isUnresolved(o[prop]))) o[prop] = value;
      return true;
    },
  });
  LAZY_TARGETS.set(proxy, obj);
  return proxy;
}

// A copy that validates as the stored value does: behind a copied lazy-var proxy only the vars the schema reads load,
// and a class instance (a ConfigVar, one with #private fields a copy would lack) is kept by reference.
function copyForCheck(value: unknown): unknown {
  return _.cloneDeepWith(value, function copy(v: unknown): unknown {
    const target = typeof v === 'object' && v !== null ? LAZY_TARGETS.get(v) : undefined;
    if (target) return withLazyVars(_.cloneDeepWith(target, copy));
    if (Object.prototype.toString.call(v) === '[object Object]' && !_.isPlainObject(v)) return v;
    return undefined;
  });
}

const decodePointer = (segment: string) => segment.replace(/~1/g, '/').replace(/~0/g, '~');

// Ajv tags the sub-errors of a propertyNames check with `propertyName`; the check itself reports the key in `params`.
const isNameError = (e: ErrorObject) => e.propertyName !== undefined;

const keyOf = (e: ErrorObject) => {
  const p = e.params as Record<string, unknown>;
  return p.missingProperty ?? p.additionalProperty ?? p.propertyName;
};

function toViolations(module: string, schema: string, errors: ErrorObject[]): ConfigurationViolation[] {
  const violations: ConfigurationViolation[] = [];

  for (const e of errors) {
    if (isNameError(e)) continue;

    const segments = e.instancePath.split('/').filter((p) => p !== '').map(decodePointer);
    const key = keyOf(e);
    if (key !== undefined) segments.push(String(key));

    let message = e.message ?? e.keyword;
    if (e.keyword === 'propertyNames') {
      const detail = errors.filter((n) => isNameError(n) && n.instancePath === e.instancePath && n.propertyName === key).map((n) => n.message ?? n.keyword);
      message = `property name is invalid${detail.length ? `: ${detail.join(', ')}` : ''}`;
    }

    violations.push({ path: [module, ...segments].join('.'), schema, message });
  }

  return violations;
}

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
  public Env : string | undefined;

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

  /** Schemas applied after boot that refused the loaded value, by schema; a read of their module throws. */
  protected RefusedModules = new Map<string, { module: string[]; error: InvalidConfiguration }>();

  private Loading = false;

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
    this.RunApp = options?.app ?? parseArgv('--app') ?? '';
    this.AppBaseDir = options?.appBaseDir ?? parseArgv('--apppath') ?? join(process.cwd(), '../apps/');
    this.Env = parseArgv('--env') ?? process.env.APP_ENV;
  }

  /**
   * Get config value for given property. If value not exists it returns default value, if default value is not provided returns undefined
   *
   * @param path - path to property eg. ["system","dirs"]
   * @param defaultValue - optional, if value at specified path not exists returns default value
   */
  public get<P extends ConfigPath>(path: P): ConfigPaths[P];
  public get<P extends ConfigPath>(path: P, defaultValue: ConfigPaths[P]): ConfigPaths[P];
  public get<T>(path: string[] | string, defaultValue?: T): T;
  public get<T>(path: string[] | string, defaultValue?: T): T {
    if (this.RefusedModules.size !== 0) this.throwIfRefused(path);
    const value = _.get(this.Config, path, defaultValue) as T;
    if (value === null && defaultValue !== undefined && this.isUnresolvedVar(path)) return defaultValue;
    return value;
  }

  private isUnresolvedVar(path: string[] | string) {
    const segments = _.toPath(path);
    if (segments.length === 0) return false;
    const parent: unknown = segments.length === 1 ? this.Config : _.get(this.Config, segments.slice(0, -1));
    const target = typeof parent === 'object' && parent !== null ? (LAZY_TARGETS.get(parent) as Record<string, unknown> | undefined) : undefined;
    return target !== undefined && isUnresolved(target[segments[segments.length - 1]]);
  }

  // A schema applied after boot cannot fail the boot; reading the value it refused, or a part of it, must still fail.
  private throwIfRefused(path: string[] | string) {
    const segments = _.toPath(path);
    // An empty path names no module (and reads nothing): it must not match every refused one.
    if (segments.length === 0) return;
    for (const { module, error } of this.RefusedModules.values()) {
      const n = Math.min(module.length, segments.length);
      if (_.isEqual(module.slice(0, n), segments.slice(0, n))) {
        throw new InvalidConfiguration(error.message, error.validationExceptions, error.violations);
      }
    }
  }

  /**
   * Sets at given path configuration value. Use when you want to override config
   * loaded from files programatically
   *
   * @param path - config path
   * @param value - value to set
   */
  public set(path: string[] | string, value: unknown) {
    assertSafePath(path);
    const schemas = this.schemasAt(path);
    this.checkChange(schemas, path, (root) => _.set(root, path, copyForCheck(value)));
    this.Config = _.set(this.Config, path, value);
    this.applySchemas(schemas);
  }

  /**
   * Merge existing config value with new options instead overriding
   *
   * @param path - cfg path
   * @param value - value to merge
   */
  public merge(path: string[] | string, value: unknown) {
    assertSafePath(path);
    const schemas = this.schemasAt(path);
    this.checkChange(schemas, path, (root) => mergeInto(_.get(root, path), copyForCheck(value)));
    mergeInto(this.get(path), value);
    this.applySchemas(schemas);
  }

  public async resolve(): Promise<void> {

    await super.resolve();

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
        InternalLogger.trace({ path: p }, 'Custom config path at: ${path}', 'Configuration');
      });
    }

    if (this.RunApp) {
      InternalLogger.info({ runApp: this.RunApp }, 'Run app is ${runApp}', 'Configuration');
    }

    InternalLogger.info({ appBaseDir: this.AppBaseDir }, 'App base dir is ${appBaseDir}', 'Configuration');

    this.initValidator();

    /**
     * Load and validate data from cfg sources
     * in proper order
     */
    this.loadSources();
    await this.load();

    try {
      this.validate();
      this.configure();
    } catch (e) {
      // DI does not cache a Configuration whose resolve failed: a schema registered later must not be checked against it.
      if (CHECKED.get(this.Container) === this) CHECKED.delete(this.Container);
      throw e;
    }
  }

  public async mergeSource(sType: Class<ConfigurationSource>) {
    const source = this.Container.resolve(sType);
    const sCfg = await source.Load(this);
    const schemas = sCfg ? _.uniq(Object.keys(sCfg).flatMap((k) => this.schemasAt([k]))) : [];
    this.checkChange(schemas, [], (root) => mergeConfig(root, copyForCheck(sCfg), 'replace'));

    this.Sources.push(source);

    if (sCfg) {
      mergeConfig(this.Config, sCfg, 'replace');
    }
    this.applySchemas(schemas);
  }

  /**
   * Reloads configuration data
   */
  public async load() {
    const previous = this.Config;
    this.Loading = true;
    try {
      await this.loadTree();
      // resolve() checks the first load itself.
      if (this.ValidationSchemas !== undefined) this.checkAll();
    } catch (e) {
      this.Config = previous;
      throw e;
    } finally {
      this.Loading = false;
    }
  }

  private async loadTree() {
    this.Config = {};
    this.NamedEnv = this.Env ?? this.Container.get<NodeJS.ProcessEnv>('process.env')?.APP_ENV ?? process.env.NODE_ENV;

    // add env variables to config
    const env = this.Container.get<NodeJS.ProcessEnv>('process.env');
    const appEnv = this.Env ?? env?.APP_ENV ?? process.env.NODE_ENV ?? 'development';
    this.set('process.env', {
      ...process.env,
      ...env,
      APP_ENV: appEnv,
    });

    // Defaults of this module, which sources may override. The flags follow the APP_ENV that selects the config files.
    mergeConfig(this.Config, _.cloneDeep(config), 'concat');
    mergeConfig(this.Config, { configuration: buildEnvironmentFlags({ APP_ENV: appEnv }) }, 'concat');

    InternalLogger.info({ appEnv: this.get<string>('process.env.APP_ENV') }, 'APP_ENV set to ${appEnv}', 'Configuration');

    /**
     * Package defaults of modules without config files, eg. in a webpack environment.
     * Merged at the root: merge() writes nothing at a key no source defines.
     */
    const defaults: IConfigLike = {};
    this.Container.resolve(Array.ofType<IConfigLike>(CONFIGURATION_SOURCES.key)).forEach((c: IConfigLike) => mergeConfig(defaults, c, 'concat'));

    await this.mergeSources(defaults);

    mergeConfig(this.Config, this.onLoad(), 'replace');


    // Every source, onLoad and DI value may set system.manifest; what was decided before the package configs loaded wins.
    const manifestSettings = this.Container.get(MANIFEST_SETTINGS, false);
    if (manifestSettings) {
      _.set(this.Config, ['system', 'manifest'], { ...manifestSettings });
    }

    this.applyAppDirs();

    // load config vars from various protocols
    await this.loadProtocolVars();

    /**
     * Each object in config replace with proxy to
     * handle protocols etc.
     */
    const proxyFunc = (obj: any) => {
      const haveProtoVals = Object.values(obj).some((v) => {
        if (v instanceof ConfigVar) {
          return true;
        }
        return false;
      });

      if (!haveProtoVals) {
        return obj;
      }

      return withLazyVars(obj);
    };

    // omit system config prop couse dir dynamic loading.
    // NOTE: the root object must be wrapped by proxyFunc AFTER merging - spreading
    // a proxied object would enumerate through the proxy get trap and eagerly
    // dereference ( and inline ) every root-level ConfigVar, breaking their laziness.
    // mapObject returns a plain object, so spreading it copies raw ConfigVar refs.
    this.Config = proxyFunc({
      system: { ...(this.Config.system as {}) },
      ...mapObject(_.omit(this.Config, ['system']), proxyFunc),
    });
  }

  private async mergeSources(defaults: IConfigLike) {
    let files: ConfigLayers[] = [];
    let packageDefaults = defaults;

    // Merged over the tree, the package layer would replace defaults already there: they join the first one instead.
    if (!this.Sources.some(isLayeredSource)) {
      mergeConfig(this.Config, packageDefaults, 'concat');
    }

    const mergeFiles = () => {
      if (files.length === 0) return;
      this.mergeFileLayers(files, packageDefaults);
      files = [];
      packageDefaults = {};
    };

    for (const source of this.Sources) {
      if (isLayeredSource(source)) {
        files.push(await source.LoadLayers(this));
        continue;
      }

      mergeFiles();

      const rCfg = await source.Load(this);
      if (rCfg) {
        mergeConfig(this.Config, rCfg, 'replace');
      }
    }

    mergeFiles();
  }

  // Packages of every format below the app of every format, so a package JSON cannot drop what a package JS file added.
  private mergeFileLayers(files: ConfigLayers[], packages: IConfigLike) {
    files.forEach((f) => mergeConfig(packages, f.packages, 'concat'));
    mergeConfig(this.Config, packages, 'replace');
    files.forEach((f) => mergeConfig(this.Config, f.app, 'replace'));
  }

  protected async loadProtocolVars() {
    const configProtocols = await this.Container.resolve(Array.ofType(ConfigVarProtocol));

    if (!configProtocols || configProtocols.length === 0) {
      InternalLogger.warn(`No configuration protocols registered`, 'Configuration');
      return;
    }

    // Build protocol map for O(1) lookup
    const protocolMap = new Map<string, ConfigVarProtocol>();
    configProtocols.forEach((p) => {
      InternalLogger.info({ protocol: p.Protocol }, 'Registered configuration protocol: ${protocol}', 'Configuration');
      protocolMap.set(p.Protocol, p);
    });

    // Build common web protocol prefix set for fast checking
    const webProtocolSet = new Set(COMMON_WEB_PROTOCOLS.map(p => p.toLowerCase()));

    const resolveString = async (obj: { [key: string]: unknown }, key: string, val: string, currentPath: string[]) => {
      // Quick check: does it contain ://?
      const protocolIndex = val.indexOf('://');
      if (protocolIndex === -1) {
        return;
      }

      // Extract potential protocol (everything before ://)
      const potentialProtocol = val.substring(0, protocolIndex + 3).toLowerCase();

      // Skip common web protocols using Set lookup (O(1))
      if (webProtocolSet.has(potentialProtocol)) {
        return;
      }

      // Use regex only if we passed initial checks
      PROTOCOL_REGEXP.lastIndex = 0;
      const match = PROTOCOL_REGEXP.exec(val);
      if (!match) {
        return;
      }

      // O(1) protocol lookup using Map
      const protocol = protocolMap.get(match[1]);

      if (!protocol) {
        InternalLogger.warn({ protocol: match[1] }, 'Protocol ${protocol} used in configuration is not registered.', 'Configuration');
        return;
      }

      const fullPath = [...currentPath, key].join('.');
      try {
        obj[key] = await protocol.getVar(match[2], this.Config);
      } catch (err) {
        InternalLogger.error({ error: err, key: fullPath, protocol: protocol.Protocol, value: val }, 'Error loading configuration var for key ${key} using protocol ${protocol}, value: ${value}', 'Configuration');
      }
    };

    const iterate = async (obj: { [key: string]: unknown }, currentPath: string[] = []) => {
      if (!obj) {
        return;
      }

      if (Array.isArray(obj)) {
        await Promise.all(
          obj.map((c, index) => (typeof c === 'string' ? resolveString(obj, String(index), c, currentPath) : iterate(c, [...currentPath, `[${index}]`]))),
        );
        return;
      }

      const stringEntries = pickString(obj);
      const objectEntries = pickObjects(obj);

      // Process strings in parallel
      await Promise.all(stringEntries.map(([key, val]) => resolveString(obj, key, val, currentPath)));

      // Process nested objects in parallel
      await Promise.all(objectEntries.map(([key, val]) => iterate(val, [...currentPath, key])));
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
    this.checkAll();

    const container = this.Container;
    CHECKED.set(container, this);
    container.once('di.resolved.Configuration', () => {
      if (CHECKED.get(container) === this) CHECKED.delete(container);
    });
  }

  /** The Configuration of `container` that has run its check but is not resolved (cached) yet. */
  public static checkedIn(container: IContainer): FrameworkConfiguration | undefined {
    return CHECKED.get(container);
  }

  private checkAll() {
    this.ValidationSchemas = this.schemasOfLineage();
    const errors: ErrorObject[] = [];
    const violations: ConfigurationViolation[] = [];
    for (const s of this.ValidationSchemas) {
      const r = this.checkModule(s);
      errors.push(...r.errors);
      violations.push(...r.violations);
    }
    this.throwIfInvalid(errors, violations);
    this.RefusedModules.clear();
  }

  // The registered schemas whose module is at, under or above `path`. None before the boot check, and none while load()
  // rebuilds the tree: it checks the whole tree once it is complete.
  private schemasAt(path: string[] | string): IConfigurationSchema[] {
    if (this.ValidationSchemas === undefined || this.Loading) return [];
    const target = _.toPath(path);
    return this.schemasOfLineage().filter((s) => {
      const module = _.toPath(s.$configurationModule);
      const n = Math.min(module.length, target.length);
      return _.isEqual(module.slice(0, n), target.slice(0, n));
    });
  }

  // Runs `change` on a copy of the modules of `schemas` and throws when one of them would become invalid, so that a
  // refused change is never applied.
  private checkChange(schemas: IConfigurationSchema[], path: string[] | string, change: (root: Record<string, unknown>) => void) {
    if (schemas.length === 0) return;
    const top = _.minBy([_.toPath(path), ...schemas.map((s) => _.toPath(s.$configurationModule))], (p) => p.length) ?? [];
    const root = (top.length === 0 ? copyForCheck(this.Config) : _.set({}, top, copyForCheck(_.get(this.Config, top)))) as Record<string, unknown>;
    change(root);

    const errors: ErrorObject[] = [];
    const violations: ConfigurationViolation[] = [];
    for (const s of schemas) {
      const value = _.get(root, s.$configurationModule);
      if (value === undefined || this.Validator.validate(s, value)) continue;
      const r = this.failureOf(s);
      errors.push(...r.errors);
      violations.push(...r.violations);
    }
    this.throwIfInvalid(errors, violations);
  }

  // Fills the defaults and coercion of the modules a change that passed checkChange() reached.
  private applySchemas(schemas: IConfigurationSchema[]) {
    for (const s of schemas) {
      const r = this.checkModule(s);
      this.throwIfInvalid(r.errors, r.violations);
      this.RefusedModules.delete(schemaNameOf(s));
    }
  }

  /** Validates one module after boot; a refused module stays refused for reads until a later check passes. */
  public validateModule(s: IConfigurationSchema) {
    const key = schemaNameOf(s);
    const r = this.checkModule(s);
    try {
      this.throwIfInvalid(r.errors, r.violations);
    } catch (e) {
      this.RefusedModules.set(key, { module: _.toPath(s.$configurationModule), error: e as InvalidConfiguration });
      throw e;
    }
    this.RefusedModules.delete(key);
  }

  private throwIfInvalid(errors: ErrorObject[], violations: ConfigurationViolation[]) {
    if (violations.length === 0) return;
    violations.forEach((v) => InternalLogger.error({ path: v.path, schema: v.schema, violation: v.message }, 'Invalid configuration at ${path} ( schema ${schema} ): ${violation}', 'Configuration'));
    throw new InvalidConfiguration(`Invalid configuration: ${violations.map((v) => `${v.path} ${v.message} ( schema ${v.schema} )`).join('; ')}`, errors, violations);
  }

  private checkModule(s: IConfigurationSchema): { errors: ErrorObject[]; violations: ConfigurationViolation[] } {
    // Not this.get: a refused module is read here to check it again.
    const config = _.get(this.Config, s.$configurationModule);

    if (config === undefined) {
      // An unconfigured module still gets its schema defaults, unless the schema needs values from the app.
      const empty = {};
      if (this.Validator.validate(s, empty)) {
        _.set(this.Config, s.$configurationModule, empty);
      } else {
        InternalLogger.warn({ module: s.$configurationModule }, 'Cannot validate configuration for module ${module}, configuration is not set', 'Configuration');
      }
      return { errors: [], violations: [] };
    }

    // Ajv coerces and fills defaults in place, and evaluates `if` before `properties` coerces. Checking the stored value
    // directly would rewrite a refused value (a null guard's null into 0) so that the next check of it passes; only a
    // value whose copy passes gets its defaults and coercion.
    if (this.Validator.validate(s, copyForCheck(config)) && this.validateInPlace(s, config)) {
      return { errors: [], violations: [] };
    }

    return this.failureOf(s);
  }

  // The violations of the last failed this.Validator.validate(s, ...) call.
  private failureOf(s: IConfigurationSchema): { errors: ErrorObject[]; violations: ConfigurationViolation[] } {
    const errors: ErrorObject[] = this.Validator.errors ?? [];
    const schema = schemaNameOf(s);
    let violations = toViolations(s.$configurationModule, schema, errors);
    if (violations.length === 0) {
      // An invalid configuration must never pass, whatever shape Ajv reported.
      violations = errors.map((e) => ({ path: [s.$configurationModule, ...e.instancePath.split('/').filter((p) => p !== '').map(decodePointer)].join('.'), schema, message: e.message ?? e.keyword }));
    }
    return { errors, violations };
  }

  private validateInPlace(s: IConfigurationSchema, config: unknown): boolean {
    keepUnresolvedVars = true;
    try {
      return this.Validator.validate(s, config);
    } finally {
      keepUnresolvedVars = false;
    }
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

      // allow rules across fields, eg. minimum: { $data: '1/min' }
      $data: true,
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
  }

  // A child that registers a schema of its own must not hide the schemas of its ancestors.
  private schemasOfLineage(): IConfigurationSchema[] {
    const found: IConfigurationSchema[] = [];
    for (let c: IContainer | undefined = this.Container; c; c = c.Parent) {
      for (const s of (c.Cache.get(CONFIGURATION_SCHEMA.key, false) ?? []) as IConfigurationSchema[]) {
        if (!found.some((f) => sameSchema(f, s))) found.push(s);
      }
    }
    return found;
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

    for (const prop of Object.keys(this.get(['system', 'dirs'], {}))) {
      const dirs = this.get<unknown>(['system', 'dirs', prop]);
      if (Array.isArray(dirs)) dirs.push(this.dir(`/${this.RunApp}/${prop}`));
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
        InternalLogger.warn({ section: prop }, 'Configuration for ${section} not exists, check configuration file', 'configuration');
        continue;
      }

      if (subconfig.configure && typeof subconfig.configure === 'function') {
        subconfig.configure.apply(this);
      }
    }
  }
}
