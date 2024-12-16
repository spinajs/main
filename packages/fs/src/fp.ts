import { _resolve } from '@spinajs/di';
import { FileHasher, FileInfoService, fs } from './interfaces.js';
import { _chain, _check_arg, _use } from '@spinajs/util';

/**
 * Gets filesystem by its name
 *
 * @param name filesystem name ( must be defined in config file)
 * @returns
 */
export function _fs(fileSystem: string | fs): () => fs {
  if (!fileSystem) {
    return null;
  }

  if (fileSystem instanceof fs) {
    return () => fileSystem;
  }

  return _resolve('__file_provider__', [fileSystem]);
}

/**
 *
 * Zips files to file
 *
 * @param srcPath files or dirs to zip ( absolute path, or relative to src fs ). if no provided, temp fs is used
 * @param dstName - relative to dst fs
 * @returns absolute path to zipped file
 */
export function _zip(srcPath: string[], dstName: string, srcFs?: string | fs) {
  return _chain(_use(_fs(srcFs), 'zipFS'), ({ zipFS }: { zipFS: fs }) => {
    return zipFS.zip(srcPath, zipFS, dstName);
  });
}

export function _unzip(srcPath: string, dstName: string, srcFs?: string | fs) {
  return _chain(_use(_fs(srcFs), 'zipFS'), ({ zipFS }: { zipFS: fs }) => {
    return zipFS.unzip(srcPath, dstName, zipFS);
  });
}

/**
 *
 * Gets file information ( extended file information eg. movie fps, coded etc.)
 *
 * @param path abs path to file
 * @returns
 */
export function _fileInfo(path: string) {
  return _chain(_use(_resolve(FileInfoService), 'fileInfo'), ({ fileInfo }: { fileInfo: FileInfoService }) => {
    return fileInfo.getInfo(path);
  });
}

/**
 * Calculates file hash
 * @param path  abs path to file
 * @returns
 */
export function _file_hash(path: string) {
  return _chain(_use(_resolve(FileHasher), 'hash'), ({ hash }: { hash: FileHasher }) => {
    return hash.hash(path);
  });
}
