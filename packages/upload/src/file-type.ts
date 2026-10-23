export type FileTypeModule = typeof import('file-type');

/**
 * file-type is ESM only. lib/cjs turns this import into require(), which Node loads as require(esm) from 20.19 on, the
 * reason for engines.node. The fs package loads it the same way (fs/src/helpers.ts:236).
 */
export function loadFileType(): Promise<FileTypeModule> {
  return import('file-type');
}
