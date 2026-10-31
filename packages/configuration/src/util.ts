/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/unbound-method */
import * as fs from 'fs';
import { dirname, join, resolve } from 'path';
import _ from 'lodash';
import { DI } from '@spinajs/di';
import { InternalLogger } from '@spinajs/internal-logger';
import type { IConfigLike } from '@spinajs/configuration-common';

// pure helpers live in util-common ( browser-safe ); re-export for compat
export { merge, mergeArrays, mapObject, pickString, pickObjects } from './util-common.js';

/**
 * Hack to inform ts that jasmine var is declared to skip syntax error
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare let jasmine: never;

export function parseArgv(param: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${param}=`));
  if (inline !== undefined) {
    return inline.slice(param.length + 1);
  }

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

/** Loads one JS config file: runs its `onConfigLoad` hook and tags every root object with `__file__`. */
export async function loadJsConfigFile(file: string): Promise<IConfigLike> {
  try {
    InternalLogger.trace({ file }, 'Trying to load file ${file}', 'Configuration');

    let cfg = (await DI.__spinajs_require__(file)) as IConfigLike;
    // execute config func before merge with rest of configuration
    if (typeof cfg.onConfigLoad === 'function') {
      cfg = (await cfg.onConfigLoad(cfg))!;
    }

    // Copies: the module object is cached, and FrameworkConfiguration seeds every later load from its own config file.
    const tagged: IConfigLike = { ...cfg };
    for (const k in tagged) {
      const value = tagged[k];
      if (_.isPlainObject(value)) {
        tagged[k] = { ...(value as Record<string, unknown>), __file__: [file] };
      }
    }

    return tagged;
  } catch (err) {
    InternalLogger.error({ error: err, file }, 'error loading configuration file ${file}', 'configuration');
    return {};
  }
}
