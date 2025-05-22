import { _resolve } from '@spinajs/di';
import { FileHasher, FileInfoService, fs, IFileInfo } from './interfaces.js';
import { _chain, _check_arg, _is_string, _non_empty, _trim, _use } from '@spinajs/util';
import { access, constants, readFile } from "fs";
import { fileTypeFromFile } from 'file-type';
import { Abortable } from 'events';
import { IOFail } from '@spinajs/exceptions';

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
export function _fileInfo(path: string): Promise<IFileInfo> {
  return _chain(_use(_resolve(FileInfoService), 'fileInfo'), ({ fileInfo }: { fileInfo: FileInfoService }) => {
    return fileInfo.getInfo(path);
  });
}

/**
 * Calculates file hash
 * @param path  abs path to file
 * @returns
 */
export function _file_hash(path: string): Promise<string> {
  return _chain(_use(_resolve(FileHasher), 'hash'), ({ hash }: { hash: FileHasher }) => {
    return hash.hash(path);
  });
}

export function _exists(path: string) {
  const p = _check_arg(_is_string(), _trim(), _non_empty())(path, 'path');

  return async () => (new Promise<boolean>((resolve) => {
    access(p, constants.F_OK, (error) => {
      resolve(!error);
    })
  }));
}

export function _is_of_type(path: string, extension: string) {
  return async () => {
    const type = await fileTypeFromFile(path);
    if (type.ext !== extension) {
      throw new IOFail(`File ${path} is invalid. Requested extension is ${extension}, file mime type is ${type.ext}`);
    }
  }
}

export function _is_of_mimetype(path: string, mimetype: string) {
  return async () => {
    const type = await fileTypeFromFile(path);
    if (type.mime !== mimetype) {
      throw new IOFail(`File ${path} is invalid. Requested mime type is ${mimetype}, file mime type is ${type.mime}`);
    }
  }
}

export function _read_file(path: string, options?:
  | ({
    encoding?: null | undefined;
    flag?: string | undefined;
  } & Abortable)
  | undefined
  | null,): () => Promise<Buffer> {

  return () => _chain<Buffer>(_exists(path), async () => {
    return new Promise((resolve, reject) => {
      readFile(path, options, (error, data: Buffer) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(data)
      })
    })
  })
}
