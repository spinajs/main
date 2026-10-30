import { readFile } from 'node:fs/promises';
import { MANIFEST_VERSION } from './types.js';
import type { Manifest, ManifestFragment } from './types.js';
import { validateFragment, validateManifest } from './validator.js';

export class ManifestVersionError extends Error {
  constructor(public readonly found: unknown, public readonly file: string) {
    super(`${file}: unsupported manifestVersion ${JSON.stringify(found)}, this reader supports ${MANIFEST_VERSION}`);
    this.name = 'ManifestVersionError';
  }
}

export class ManifestValidationError extends Error {
  constructor(public readonly errors: string[], public readonly file: string) {
    super(`${file}: invalid manifest\n${errors.join('\n')}`);
    this.name = 'ManifestValidationError';
  }
}

async function load<T>(path: string, validate: (v: unknown) => string[]): Promise<T> {
  const value = JSON.parse(await readFile(path, 'utf8')) as { manifestVersion?: unknown };
  if (value?.manifestVersion !== MANIFEST_VERSION) throw new ManifestVersionError(value?.manifestVersion, path);

  const errors = validate(value);
  if (errors.length) throw new ManifestValidationError(errors, path);
  return value as T;
}

export const readManifest = (path: string): Promise<Manifest> => load<Manifest>(path, validateManifest);
export const readFragment = (path: string): Promise<ManifestFragment> => load<ManifestFragment>(path, validateFragment);
