/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import _ from 'lodash';
import {
  ConfigurationSource,
  IConfigLike,
  Configuration,
  ConfigurationOptions,
  IConfigurable,
  ConfigVar,
} from '@spinajs/configuration-common';
import { Autoinject, Class, Container, Injectable } from '@spinajs/di';

import { mergeArrays, mapObject } from './util-common.js';

/**
 * Browser variant of FrameworkConfiguration.
 *
 * Same public surface and merge/configure semantics as the Node version, but
 * with NO fs / path / process / ajv in its import graph:
 *  - config comes exclusively from DI-registered `ConfigurationSource`s
 *    ( eg. StaticConfigurationSource ) and the `__configuration__` DI seam
 *  - no file loading, no schema validation, no CLI-arg / env-var probing
 *  - runtime overrides via `set` / `merge` or another `__configuration__` value
 *    followed by `load()`
 */
@Injectable(Configuration)
export class BrowserFrameworkConfiguration extends Configuration {
  public AppBaseDir = './';

  public RunApp = '';

  protected Config: Record<string, unknown> = {};

  protected Sources: ConfigurationSource[] = [];

  public get RootConfig() {
    return this.Config as IConfigLike;
  }

  @Autoinject()
  protected Container: Container;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_options?: ConfigurationOptions) {
    super();
  }

  public get<T>(path: string[] | string, defaultValue?: T): T {
    return _.get(this.Config, path, defaultValue) as T;
  }

  public set(path: string[] | string, value: unknown) {
    this.Config = _.set(this.Config, path, value);
  }

  public merge(path: string[] | string, value: unknown) {
    _.mergeWith(this.get(path), value, mergeArrays);
  }

  public async resolve(): Promise<void> {
    await super.resolve();

    // Collect DI-registered configuration sources ( if any ), sorted by Order.
    // Unlike the Node version we do NOT require a source to be present — a
    // browser app may configure entirely through the `__configuration__` seam.
    if (this.Container.hasRegistered(ConfigurationSource)) {
      this.Sources = this.Container.resolve(Array.ofType(ConfigurationSource));
      this.Sources.sort((a, b) => (a.Order < b.Order ? -1 : a.Order > b.Order ? 1 : 0));
    } else {
      this.Sources = [];
    }

    await this.load();
    this.configure();
  }

  public async mergeSource(sType: Class<ConfigurationSource>) {
    const source = this.Container.resolve(sType);
    const sCfg = await source.Load(this);

    this.Sources.push(source);

    if (sCfg) {
      _.mergeWith(this.Config, sCfg, mergeArrays);
    }
  }

  public async load() {
    this.Config = {};

    for (const source of this.Sources) {
      const rCfg = await source.Load(this);
      if (rCfg) {
        _.mergeWith(this.Config, rCfg, mergeArrays);
      }
    }

    _.mergeWith(this.Config, this.onLoad(), mergeArrays);

    /**
     * Merge from DI container ( '__configuration__' seam )
     * eg. when custom modules have config and dont want to use files.
     * Root-level merge ( not per-key this.merge ) so keys that don't exist in
     * the config yet are still applied — merge() into a missing key is a no-op.
     */
    this.Container.resolve(Array.ofType<IConfigLike>('__configuration__')).forEach((c: IConfigLike) => {
      _.mergeWith(this.Config, c, mergeArrays);
    });

    /**
     * Each object in config replace with proxy to handle lazy ConfigVars.
     */
    const proxyFunc = (obj: any) => {
      const haveProtoVals = Object.values(obj).some((v) => v instanceof ConfigVar);

      if (!haveProtoVals) {
        return obj;
      }

      return new Proxy(obj, {
        get: (o, prop) => {
          if (o[prop] instanceof ConfigVar) {
            return o[prop].get();
          }
          return o[prop];
        },
      });
    };

    this.Config = proxyFunc({
      system: { ...(this.Config.system as {}) },
      ...mapObject(_.omit(this.Config, ['system']), proxyFunc),
    });
  }

  protected onLoad(): unknown {
    return null;
  }

  /**
   * runs configuration func on config subsections
   */
  protected configure() {
    for (const prop of Object.keys(this.Config)) {
      const subconfig = this.Config[`${prop}`] as IConfigurable;

      if (!subconfig) {
        continue;
      }

      if (subconfig.configure && typeof subconfig.configure === 'function') {
        subconfig.configure.apply(this);
      }
    }
  }
}
