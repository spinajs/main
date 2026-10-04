import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BaseFileSource } from '@spinajs/configuration';
import type { IConfigLike } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import _ from 'lodash';

import { ConversionError } from './findings.js';
import type { Plain } from './values.js';

/** The common layer and one layer per environment, each merged the way the 3.0 loader merges it. */
export interface ConfigLayers {
  readonly common: Plain;
  /** Env suffix (the `local` of `rbac.local.js`) → that env's files merged. */
  readonly envs: ReadonlyMap<string, Plain>;
  readonly files: readonly string[];
}

// The same customizer as @spinajs/configuration's mergeArrays: arrays concatenate across files.
export const mergeArrays = (target: unknown, source: unknown): unknown => (Array.isArray(target) ? target.concat(source) : undefined);

export const mergeLayers = (...layers: Plain[]): Plain => layers.reduce((acc: Plain, l) => _.mergeWith(acc, _.cloneDeep(l), mergeArrays) as Plain, {});

const CONFIG_EXT = /\.(js|cjs|json)$/;

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
  constructor(dirs: readonly string[]) {
    super();
    // The app's own config dirs only: package defaults come from the 3.0 packages after the upgrade.
    this.CommonDirs = [...dirs];
    this.BasePath = '';
  }

  public Load(): Promise<IConfigLike> {
    return Promise.reject(new Error('LayerSource loads layers through layer()'));
  }

  public async layer(env: string | null): Promise<Plain> {
    const stem = env === null ? '!(*.*)' : `*.${env}`;
    const js = await this.load(`${stem}.{cjs,js}`, loadStrict);
    const json = await this.load(`${stem}.json`, loadStrict);
    return _.mergeWith(js, json, mergeArrays) as Plain;
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

/** Loads every config layer under `dirs` (compiled .js/.cjs and .json files; TypeScript sources are refused). */
export async function loadLayers(dirs: readonly string[]): Promise<ConfigLayers> {
  if (dirs.length === 0) throw new ConversionError(['no config dir given']);
  const problems: string[] = [];
  const files: string[] = [];
  const envs = new Set<string>();
  const resolved = dirs.map((d) => path.resolve(d));
  for (const dir of resolved) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      problems.push(`config dir ${dir} does not exist`);
      continue;
    }
    const all: string[] = [];
    walk(dir, all);
    const configs = all.filter((f) => CONFIG_EXT.test(f));
    if (configs.length === 0) {
      const ts = all.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
      problems.push(
        ts.length > 0
          ? `config dir ${dir} holds TypeScript sources only; build the app and point the converter at the compiled config dir (for example lib/mjs/config)`
          : `config dir ${dir} holds no .js, .cjs or .json config file`,
      );
      continue;
    }
    for (const f of configs) {
      files.push(f);
      const env = envOf(f);
      if (env !== null) envs.add(env);
    }
  }
  if (problems.length > 0) throw new ConversionError(problems);

  DI.setESMModuleSupport();
  const source = new LayerSource(resolved);
  const common = await source.layer(null);
  const byEnv = new Map<string, Plain>();
  for (const env of [...envs].sort()) byEnv.set(env, await source.layer(env));
  return { common, envs: byEnv, files: files.sort() };
}
