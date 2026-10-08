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

export function parseArgv(param: string): string | undefined {
  const index = process.argv.indexOf(param);

  if (index === -1 || process.argv.length <= index + 1) {
    return undefined;
  }

  return process.argv[index + 1];
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
