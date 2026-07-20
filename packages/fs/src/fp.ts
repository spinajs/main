import { _resolve, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FileHasher, FileInfoService, fs, IFileInfo, IStat } from './interfaces.js';
import { _chain, _check_arg, _is_string, _non_empty, _trim, _use } from '@spinajs/util';
import { access, constants, readFile } from "fs";
import { Abortable } from 'events';
import { IOFail } from '@spinajs/exceptions';

/**
 * Resolves a filesystem provider by name / instance, or falls back to the
 * configured default provider ( fs.defaultProvider ) when none is given.
 *
 * @param fileSystem provider name, provider instance, or undefined for the default
 */
function _provider(fileSystem?: string | fs): () => fs {
  return () => {
    const name = fileSystem ?? DI.get<Configuration>(Configuration)?.get<string>('fs.defaultProvider');

    if (!name) {
      throw new IOFail(`No filesystem provided and no fs.defaultProvider configured`);
    }

    const f = _fs(name)();

    if (!f) {
      throw new IOFail(`Filesystem ${typeof name === 'string' ? name : name.Name} not found`);
    }

    return f;
  };
}

/**
 * Gets filesystem by its name
 *
 * @param name filesystem name ( must be defined in config file)
 * @returns
 */
export function _fs(fileSystem: string | fs): () => fs | undefined {
  if (!fileSystem) {
    return () => undefined;
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
  return _chain(_use(_fs(srcFs ?? 'fs-temp'), 'zipFS'), ({ zipFS }: { zipFS: fs }) => {
    return zipFS.zip(srcPath, zipFS, dstName);
  });
}

export function _unzip(srcPath: string, dstName: string, srcFs?: string | fs) {
  return _chain(_use(_fs(srcFs ?? 'fs-temp'), 'zipFS'), ({ zipFS }: { zipFS: fs }) => {
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

/**
 * Checks if a path exists.
 *
 * Without a filesystem, checks an absolute local path directly. With a filesystem
 * ( name or instance ), delegates to that provider ( path relative to its base ).
 *
 * @param path path to check
 * @param fileSystem optional provider name / instance
 */
export function _exists(path: string, fileSystem?: string | fs) {
  const p = _check_arg(_is_string(), _trim(), _non_empty())(path, 'path');

  if (fileSystem !== undefined) {
    return async () => _provider(fileSystem)().exists(p);
  }

  return async () => (new Promise<boolean>((resolve) => {
    access(p, constants.F_OK, (error) => {
      resolve(!error);
    })
  }));
}

/**
 * Reads whole file content through a filesystem provider.
 *
 * @param path path relative to provider base
 * @param encoding optional encoding ( raw Buffer when omitted )
 * @param fileSystem provider name / instance, or default provider
 */
export function _read(path: string, encoding?: BufferEncoding, fileSystem?: string | fs): Promise<string | Buffer> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.read(path, encoding));
}

/**
 * Writes data to a file through a filesystem provider.
 */
export function _write(path: string, data: string | Uint8Array, encoding?: BufferEncoding, fileSystem?: string | fs): Promise<void> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.write(path, data, encoding));
}

/**
 * Appends data to a file through a filesystem provider.
 */
export function _append(path: string, data: string | Uint8Array, encoding?: BufferEncoding, fileSystem?: string | fs): Promise<void> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.append(path, data, encoding));
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
  return _chain(_use(_provider(srcFs), 'f'), ({ f }: { f: fs }) => f.copy(src, dst, dstFs ? _provider(dstFs)() : undefined));
}

/**
 * Moves a file / dir, optionally into another filesystem.
 */
export function _move(src: string, dst: string, srcFs?: string | fs, dstFs?: string | fs): Promise<void> {
  return _chain(_use(_provider(srcFs), 'f'), ({ f }: { f: fs }) => f.move(src, dst, dstFs ? _provider(dstFs)() : undefined));
}

/**
 * Renames a file within a single filesystem.
 */
export function _rename(oldPath: string, newPath: string, fileSystem?: string | fs): Promise<void> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.rename(oldPath, newPath));
}

/**
 * Removes a file or a directory ( recursively ).
 */
export function _rm(path: string, fileSystem?: string | fs): Promise<void> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.rm(path));
}

/**
 * Creates a directory ( recursively ).
 */
export function _mkdir(path: string, fileSystem?: string | fs): Promise<void> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.mkdir(path));
}

/**
 * Lists directory content.
 */
export function _list(path: string, fileSystem?: string | fs): Promise<string[]> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.list(path));
}

/**
 * Returns file / dir statistics.
 */
export function _stat(path: string, fileSystem?: string | fs): Promise<IStat> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.stat(path));
}

/**
 * Checks if a path is an existing directory.
 */
export function _dir_exists(path: string, fileSystem?: string | fs): Promise<boolean> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.dirExists(path));
}

/**
 * Checks if a path is a directory.
 */
export function _is_dir(path: string, fileSystem?: string | fs): Promise<boolean> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.isDir(path));
}

/**
 * Downloads a file to local storage and returns the local path.
 */
export function _download(path: string, fileSystem?: string | fs): Promise<string> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.download(path));
}

/**
 * Uploads a local file into a filesystem provider.
 */
export function _upload(srcPath: string, dstPath?: string, fileSystem?: string | fs): Promise<void> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.upload(srcPath, dstPath));
}

/**
 * Hashes a file through a filesystem provider.
 */
export function _hash(path: string, algo?: string, fileSystem?: string | fs): Promise<string> {
  return _chain(_use(_provider(fileSystem), 'f'), ({ f }: { f: fs }) => f.hash(path, algo));
}

export function _is_of_type(path: string, extension: string) {
  return async () => {
    const { fileTypeFromFile } = await import('file-type');
    const type = await fileTypeFromFile(path);
    if (type!.ext !== extension) {
      throw new IOFail(`File ${path} is invalid. Requested extension is ${extension}, file mime type is ${type!.ext}`);
    }
  }
}

export function _is_of_mimetype(path: string, mimetype: string) {
  return async () => {
    const { fileTypeFromFile } = await import('file-type');
    const type = await fileTypeFromFile(path);
    if (type!.mime !== mimetype) {
      throw new IOFail(`File ${path} is invalid. Requested mime type is ${mimetype}, file mime type is ${type!.mime}`);
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
