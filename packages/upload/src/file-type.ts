export type FileTypeModule = typeof import('file-type');

/** file-type is ESM only; since 4.0 every package is ESM so a plain import is fine. */
export function loadFileType(): Promise<FileTypeModule> {
  return import('file-type');
}
