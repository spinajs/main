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

function check<T>(value: unknown, file: string, validate: (v: unknown) => string[]): T {
  const version = (value as { manifestVersion?: unknown } | null)?.manifestVersion;
  if (version !== MANIFEST_VERSION) throw new ManifestVersionError(version, file);

  const errors = validate(value);
  if (errors.length) throw new ManifestValidationError(errors, file);
  return value as T;
}

async function load<T>(path: string, validate: (v: unknown) => string[]): Promise<T> {
  return check<T>(JSON.parse(await readFile(path, 'utf8')), path, validate);
}

export const readManifest = (path: string): Promise<Manifest> => load<Manifest>(path, validateManifest);
export const readFragment = (path: string): Promise<ManifestFragment> => load<ManifestFragment>(path, validateFragment);

/** Validates an already parsed manifest; `file` only labels errors. */
export const readManifestObject = (value: unknown, file = '<manifest>'): Manifest => check<Manifest>(value, file, validateManifest);
