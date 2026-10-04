import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BaseFileSource } from '@spinajs/configuration';
import type { IConfigLike } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import _ from 'lodash';

import { ConversionError } from './findings.js';
import { isPlain } from './values.js';
import type { Plain } from './values.js';

/** One layer's files: JS/CJS and JSON are separate sources of the configuration, JS first. */
interface Sources {
  readonly js: Plain;
  readonly json: Plain;
}

/** The common layer and one layer per environment, each merged the way the 3.0 loader merges it. */
export interface ConfigLayers {
  readonly common: Plain;
  /** Env suffix (the `local` of `rbac.local.js`) → that env's files merged. */
  readonly envs: ReadonlyMap<string, Plain>;
  readonly files: readonly string[];
  /** Files the configuration loader never reads, with the reason. */
  readonly skipped: readonly string[];
  /** The config the loader builds for `env` (null: no env file applies). */
  view(env: string | null): Plain;
}

// The same customizer as @spinajs/configuration's mergeArrays: arrays concatenate across files.
export const mergeArrays = (target: unknown, source: unknown): unknown => (Array.isArray(target) ? target.concat(source) : undefined);

export const mergeLayers = (...layers: Plain[]): Plain => layers.reduce((acc: Plain, l) => _.mergeWith(acc, _.cloneDeep(l), mergeArrays) as Plain, {});

const CONFIG_EXT = /\.(js|cjs|json)$/;
const TS_SOURCE = /\.(ts|mts|cts)$/;
// normalizeEnvironment turns these into 'prod' and 'dev', so a file with the long suffix is never loaded.
const NEVER_LOADED_ENVS = ['production', 'development'];

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

/** `rbac.js` → common; `rbac.local.js` → env `local`; the patterns JsFileSource and JsonFileSource load. */
function envOf(file: string): string | null {
  const parts = path.basename(file).split('.');
  return parts.length === 2 ? null : parts[parts.length - 2];
}

class LayerSource extends BaseFileSource {
  readonly loaded = new Set<string>();

  constructor(dirs: readonly string[]) {
    super();
    // The app's own config dirs only: package defaults come from the 3.0 packages after the upgrade.
    this.CommonDirs = [...dirs];
    this.BasePath = '';
  }

  public Load(): Promise<IConfigLike> {
    return Promise.reject(new Error('LayerSource loads layers through layer()'));
  }

  public async layer(env: string | null): Promise<Sources> {
    const stem = env === null ? '!(*.*)' : `*.${env}`;
    const strict = (file: string) => {
      this.loaded.add(path.resolve(file));
      return loadStrict(file);
    };
    return { js: (await this.load(`${stem}.{cjs,js}`, strict)) as Plain, json: (await this.load(`${stem}.json`, strict)) as Plain };
  }
}

// JsFileSource logs a broken file and goes on with {}; a converter that did so would drop keys silently.
async function loadStrict(file: string): Promise<IConfigLike> {
  try {
    if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf-8')) as IConfigLike;
    let cfg = (await DI.__spinajs_require__(pathToFileURL(file).href)) as IConfigLike;
    if (typeof cfg.onConfigLoad === 'function') cfg = (await cfg.onConfigLoad(cfg))!;
    return cfg;
  } catch (err) {
    throw new ConversionError([`cannot load config file ${file}: ${(err as Error).message}`]);
  }
}

function leaves(v: unknown, at: string, out: Set<string>): Set<string> {
  if (isPlain(v) && Object.keys(v).length > 0) for (const [k, c] of Object.entries(v)) leaves(c, at === '' ? k : `${at}.${k}`, out);
  else if (at !== '') out.add(at);
  return out;
}

/** Loads every config layer under `dirs` (compiled .js/.cjs and .json files; TypeScript sources are refused). */
export async function loadLayers(dirs: readonly string[]): Promise<ConfigLayers> {
  if (dirs.length === 0) throw new ConversionError(['no config dir given']);
  const problems: string[] = [];
  const files: string[] = [];
  const skipped: string[] = [];
  const envs = new Set<string>();
  const resolved = dirs.map((d) => path.resolve(d));
  for (const dir of resolved) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      problems.push(`config dir ${dir} does not exist`);
      continue;
    }
    const all: string[] = [];
    walk(dir, all);
    const ts = all.filter((f) => TS_SOURCE.test(f) && !/\.d\.[mc]?ts$/.test(f));
    if (ts.length > 0) {
      problems.push(`config dir ${dir} holds TypeScript sources (${path.basename(ts[0])}); build the app and point the converter at the compiled config dir (for example lib/mjs/config)`);
      continue;
    }
    const configs = all.filter((f) => CONFIG_EXT.test(f));
    if (configs.length === 0) {
      problems.push(`config dir ${dir} holds no .js, .cjs or .json config file`);
      continue;
    }
    for (const f of configs) {
      const env = envOf(f);
      if (path.basename(f).startsWith('.')) {
        skipped.push(`${f}: a dot file is not a config file`);
        continue;
      }
      if (env !== null && NEVER_LOADED_ENVS.includes(env)) {
        skipped.push(`${f}: the loader reads env '${env}' as '${env === 'production' ? 'prod' : 'dev'}', so it never loads this file`);
        continue;
      }
      files.push(f);
      if (env !== null) envs.add(env);
    }
  }
  if (problems.length > 0) throw new ConversionError(problems);

  DI.setESMModuleSupport();
  const source = new LayerSource(resolved);
  const common = await source.layer(null);
  const bySuffix = new Map<string, Sources>();
  for (const env of [...envs].sort()) bySuffix.set(env, await source.layer(env));

  const missed = files.filter((f) => !source.loaded.has(path.resolve(f)));
  if (missed.length > 0) problems.push(`the configuration loader did not read ${missed.join(', ')}; move the config files to a plain directory path`);

  // The loader applies (common JS + env JS), then (common JSON + env JSON); the generated files load as
  // (common, env). They agree unless an env JS file and a common JSON file set the same key.
  const commonJson = leaves(common.json, '', new Set());
  for (const [env, s] of bySuffix) {
    const clash = [...leaves(s.js, '', new Set())].filter((k) => commonJson.has(k));
    if (clash.length > 0) problems.push(`env '${env}' JS files and common JSON files both set ${clash.join(', ')}; the loader lets the JSON win, the converted files could not. Move the key into one kind of file`);
  }
  if (problems.length > 0) throw new ConversionError(problems);

  const flat = (s: Sources) => mergeLayers(s.js, s.json);
  return {
    common: flat(common),
    envs: new Map([...bySuffix].map(([env, s]) => [env, flat(s)])),
    files: files.sort(),
    skipped,
    view: (env) => {
      const e = env === null ? undefined : bySuffix.get(env);
      return e ? mergeLayers(common.js, e.js, common.json, e.json) : flat(common);
    },
  };
}
