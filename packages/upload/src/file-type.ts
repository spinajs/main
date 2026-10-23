export type FileTypeModule = typeof import('file-type');

/**
 * file-type is ESM only. lib/cjs turns this import into require(), which Node loads as require(esm)
 * (test/spikes/file-type-builds.test.ts). the fs package loads it the same way (fs/src/helpers.ts:236).
 */
export function loadFileType(): Promise<FileTypeModule> {
  return import('file-type');
}
