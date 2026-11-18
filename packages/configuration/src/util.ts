/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/unbound-method */
import * as fs from 'fs';
import { dirname, join, resolve } from 'path';

// pure helpers live in util-common ( browser-safe ); re-export for compat
export { merge, mergeArrays, mapObject, pickString, pickObjects } from './util-common.js';

/**
 * Hack to inform ts that jasmine var is declared to skip syntax error
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare let jasmine: never;

export function parseArgv(param: string, argv: readonly string[] = process.argv): string | undefined {
  const index = argv.indexOf(param);

  if (index === -1 || argv.length <= index + 1) {
    return undefined;
  }

  return argv[index + 1];
}

export interface ChosenEnvironment {
  /** As given, not normalized: pass it to `normalizeEnvironment()` for the file suffix. */
  name: string;
  from: '--env' | 'APP_ENV' | 'NODE_ENV' | 'default';
}

/**
 * The environment `FrameworkConfiguration` loads when no `process.env` DI value is registered and `Env` is not set:
 * `--env`, then `APP_ENV`, then `NODE_ENV`, then `development`. Usable before the configuration resolves.
 */
export function chooseEnvironment(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): ChosenEnvironment {
  const fromArgv = parseArgv('--env', argv);
  if (fromArgv !== undefined) return { name: fromArgv, from: '--env' };
  if (env.APP_ENV !== undefined) return { name: env.APP_ENV, from: 'APP_ENV' };
  if (env.NODE_ENV !== undefined) return { name: env.NODE_ENV, from: 'NODE_ENV' };
  return { name: 'development', from: 'default' };
}

export function findBasePath(path: string): string | null {
  if (fs.existsSync(join(path, 'node_modules'))) {
    return path;
  }

  const parentPath = dirname(path);

  // if we reach root eg c:\
  // and nothing is found return null
  if (parentPath === path) {
    return null;
  }

  return findBasePath(resolve(path, '..'));
}

// clean require cache config
// http://stackoverflow.com/questions/9210542/node-js-require-cache-possible-to-invalidate
export function uncache(file: string) {
  delete require.cache[`${file}`];
  return file;
}

export function filterDirs(dir: string) {
  if (fs.existsSync(dir)) {
    return true;
  }
  return false;
}

type SchemaIds = { $id?: string; $configurationModule: string };

/** How violations and refusals name a schema: its `$id`, else its `$configurationModule`. */
export const schemaNameOf = (s: SchemaIds): string => s.$id ?? s.$configurationModule;

/** The same object, or a copy with the same `$id`, as the cjs and the mjs build of one package give. */
export const sameSchema = (a: SchemaIds, b: SchemaIds): boolean => a === b || (a.$id !== undefined && a.$id === b.$id);
