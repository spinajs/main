import { fs, IFileInfo, IStat } from './interfaces.js';
import { Abortable } from 'events';
import {
  append,
  copy,
  dirExists,
  download,
  exists,
  fileHash,
  fileInfo,
  getFs,
  hash,
  isDir,
  isOfMimetype,
  isOfType,
  list,
  mkdir,
  move,
  read,
  readFile,
  rename,
  rm,
  stat,
  unzip,
  upload,
  write,
  zip,
} from './helpers.js';

/**
 * Functional-style wrappers kept for compatibility and composability -
 * each delegates to its imperative counterpart in helpers.ts.
 */

/**
 * Gets filesystem by its name
 *
 * @param fileSystem filesystem name ( must be defined in config file) or instance
 * @returns
 */
export function _fs(fileSystem: string | fs): () => fs | undefined {
  return () => getFs(fileSystem);
}

/**
 *
 * Zips files to file
 *
 * @param srcPath files or dirs to zip ( absolute path, or relative to src fs ). if no provided, temp fs is used
 * @param dstName - relative to dst fs
 * @param srcFs - source provider name / instance ( temp fs when omitted )
 * @param dstFs - optional destination provider - archive lands in srcFs when omitted
 * @returns absolute path to zipped file
 */
export function _zip(srcPath: string[], dstName: string, srcFs?: string | fs, dstFs?: string | fs) {
  return zip(srcPath, dstName, srcFs, dstFs);
}

export function _unzip(srcPath: string, dstName: string, srcFs?: string | fs) {
  return unzip(srcPath, dstName, srcFs);
}

/**
 *
 * Gets file information ( extended file information eg. movie fps, coded etc.)
 *
 * @param path abs path to file
 * @returns
 */
export function _fileInfo(path: string): Promise<IFileInfo> {
  return fileInfo(path);
}

/**
 * Calculates file hash
 * @param path  abs path to file
 * @returns
 */
export function _fileHash(path: string): Promise<string> {
  return fileHash(path);
}

/**
 * Checks if a path exists.
 *
 * Without a filesystem, checks an absolute local path directly. With a filesystem
 * ( name or instance ), delegates to that provider ( path relative to its base ).
 *
 * @param path path to check
 * @param fileSystem optional provider name / instance
 */
export function _exists(path: string, fileSystem?: string | fs): () => Promise<boolean> {
  return () => exists(path, fileSystem);
}

/**
 * Reads whole file content through a filesystem provider.
 *
 * @param path path relative to provider base
 * @param encoding optional encoding ( raw Buffer when omitted )
 * @param fileSystem provider name / instance, or default provider
 */
export function _read(path: string, encoding?: BufferEncoding, fileSystem?: string | fs): Promise<string | Buffer> {
  return read(path, encoding, fileSystem);
}

/**
 * Writes data to a file through a filesystem provider.
 */
export function _write(path: string, data: string | Uint8Array, encoding?: BufferEncoding, fileSystem?: string | fs): Promise<void> {
  return write(path, data, encoding, fileSystem);
}

/**
 * Appends data to a file through a filesystem provider.
 */
export function _append(path: string, data: string | Uint8Array, encoding?: BufferEncoding, fileSystem?: string | fs): Promise<void> {
  return append(path, data, encoding, fileSystem);
}

/**
 * Copies a file / dir, optionally into another filesystem.
 *
 * @param src source path ( relative to srcFs )
 * @param dst destination path
 * @param srcFs source provider name / instance ( default provider when omitted )
 * @param dstFs optional destination provider - copy within srcFs when omitted
 */
export function _copy(src: string, dst: string, srcFs?: string | fs, dstFs?: string | fs): Promise<void> {
  return copy(src, dst, srcFs, dstFs);
}

/**
 * Moves a file / dir, optionally into another filesystem.
 */
export function _move(src: string, dst: string, srcFs?: string | fs, dstFs?: string | fs): Promise<void> {
  return move(src, dst, srcFs, dstFs);
}

/**
 * Renames a file within a single filesystem.
 */
export function _rename(oldPath: string, newPath: string, fileSystem?: string | fs): Promise<void> {
  return rename(oldPath, newPath, fileSystem);
}

/**
 * Removes a file or a directory ( recursively ).
 */
export function _rm(path: string, fileSystem?: string | fs): Promise<void> {
  return rm(path, fileSystem);
}

/**
 * Creates a directory ( recursively ).
 */
export function _mkdir(path: string, fileSystem?: string | fs): Promise<void> {
  return mkdir(path, fileSystem);
}

/**
 * Lists directory content.
 */
export function _list(path: string, fileSystem?: string | fs): Promise<string[]> {
  return list(path, fileSystem);
}

/**
 * Returns file / dir statistics.
 */
export function _stat(path: string, fileSystem?: string | fs): Promise<IStat> {
  return stat(path, fileSystem);
}

/**
 * Checks if a path is an existing directory.
 */
export function _dirExists(path: string, fileSystem?: string | fs): Promise<boolean> {
  return dirExists(path, fileSystem);
}

/**
 * Checks if a path is a directory.
 */
export function _isDir(path: string, fileSystem?: string | fs): Promise<boolean> {
  return isDir(path, fileSystem);
}

/**
 * Downloads a file to local storage and returns the local path.
 */
export function _download(path: string, fileSystem?: string | fs): Promise<string> {
  return download(path, fileSystem);
}

/**
 * Uploads a local file into a filesystem provider.
 */
export function _upload(srcPath: string, dstPath?: string, fileSystem?: string | fs): Promise<void> {
  return upload(srcPath, dstPath, fileSystem);
}

/**
 * Hashes a file through a filesystem provider.
 */
export function _hash(path: string, algo?: string, fileSystem?: string | fs): Promise<string> {
  return hash(path, algo, fileSystem);
}

export function _isOfType(path: string, extension: string): () => Promise<void> {
  return () => isOfType(path, extension);
}

export function _isOfMimetype(path: string, mimetype: string): () => Promise<void> {
  return () => isOfMimetype(path, mimetype);
}

export function _readFile(
  path: string,
  options?:
    | ({
        encoding?: null | undefined;
        flag?: string | undefined;
      } & Abortable)
    | undefined
    | null,
): () => Promise<Buffer> {
  return () => readFile(path, options);
}
