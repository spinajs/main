import { basename, extname } from 'node:path';
import { DateTime } from 'luxon';
import { CONFIG_FILE_DEFAULT_MAX_SIZE } from '@spinajs/configuration-db-source';
import type { IConfigFileCandidate, IConfigurationFileOptions } from '@spinajs/configuration-db-source';

export const ORIGINAL_NAME_MAX_LENGTH = 255;

// storedFileName caps the base at 100 chars and appends a fixed-length timestamp, but not the
// extension - an overlong one could still push the generated name past a project's column size
export const EXTENSION_MAX_LENGTH = 16;

const BASE_NAME_MAX_LENGTH = 100;

export function fileExtension(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

/** Timestamped so an upload never overwrites a repo-owned default or an earlier upload. */
export function storedFileName(originalName: string, uploadedAt: DateTime): string {
  const extension = fileExtension(originalName);
  const base =
    basename(originalName, extname(originalName))
      .replace(/[^\w.-]/g, '_')
      .slice(0, BASE_NAME_MAX_LENGTH) || 'file';
  const stamp = uploadedAt.toUTC().toFormat('yyyyMMdd-HHmmss');

  return extension ? `${base}-${stamp}.${extension}` : `${base}-${stamp}`;
}

/** The first broken rule as an admin-facing message, `null` when the candidate passes all of them. */
export function checkFileRules(options: IConfigurationFileOptions, candidate: IConfigFileCandidate): string | null {
  if (candidate.originalName.length > ORIGINAL_NAME_MAX_LENGTH) {
    return `File name is too long: ${candidate.originalName.length} characters, the limit is ${ORIGINAL_NAME_MAX_LENGTH}`;
  }

  const extension = fileExtension(candidate.originalName);
  if (extension.length > EXTENSION_MAX_LENGTH) {
    return `File extension is too long: ${extension.length} characters, the limit is ${EXTENSION_MAX_LENGTH}`;
  }

  const maxSize = options.maxSize ?? CONFIG_FILE_DEFAULT_MAX_SIZE;
  if (candidate.size > maxSize) {
    return `File is too large: ${candidate.size} bytes, the limit is ${maxSize} bytes`;
  }

  if (options.extensions?.length && !options.extensions.some((e) => e.toLowerCase() === extension)) {
    return `File extension must be one of: ${options.extensions.join(', ')}. Got: ${extension || 'none'}`;
  }

  if (options.mimeTypes?.length && !options.mimeTypes.includes(candidate.mimeType)) {
    return `File content type must be one of: ${options.mimeTypes.join(', ')}. Got: ${candidate.mimeType || 'unknown'}`;
  }

  return null;
}
