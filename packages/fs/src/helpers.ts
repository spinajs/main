import { get, resolve } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FileHasher, FileInfoService, fs, IFileInfo, IStat } from './interfaces.js';
import { _check_arg, _is_string, _non_empty, _trim } from '@spinajs/util';
import { access, constants, readFile as nodeReadFile } from 'fs';
import { Abortable } from 'events';
import { IOFail } from '@spinajs/exceptions';

/**
 * Resolves a filesystem provider by name / instance, or falls back to the
 * configured default provider ( fs.defaultProvider ) when none is given.
 *
 * @param fileSystem provider name, provider instance, or undefined for the default
 */
export function provider(fileSystem?: string | fs): fs {
  const name = fileSystem ?? get(Configuration)?.get<string>('fs.defaultProvider');

  if (!name) {
    throw new IOFail(`No filesystem provided and no fs.defaultProvider configured`);
  }

  const f = getFs(name);

  if (!f) {
    throw new IOFail(`Filesystem ${typeof name === 'string' ? name : name.Name} not found`);
  }

  return f;
}

/**
 * Gets filesystem by its name
 *
 * @param fileSystem filesystem name ( must be defined in config file) or instance
 * @returns
 */
export function getFs(fileSystem: string | fs): fs;
export function getFs(fileSystem: string | fs | undefined | null): fs | undefined;
export function getFs(fileSystem: string | fs | undefined | null): fs | undefined {
  if (!fileSystem) {
    return undefined;
  }

  if (fileSystem instanceof fs) {
    return fileSystem;
  }

  return resolve<fs>('__file_provider__', [fileSystem]);
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
export async function zip(srcPath: string[], dstName: string, srcFs?: string | fs, dstFs?: string | fs) {
  const zipFS = provider(srcFs ?? 'fs-temp');
  return zipFS.zip(srcPath, dstFs ? provider(dstFs) : zipFS, dstName);
}

export async function unzip(srcPath: string, dstName: string, srcFs?: string | fs) {
  const zipFS = provider(srcFs ?? 'fs-temp');
  return zipFS.unzip(srcPath, dstName, zipFS);
}

/**
 *
 * Gets file information ( extended file information eg. movie fps, coded etc.)
 *
 * @param path abs path to file
 * @returns
 */
export async function fileInfo(path: string): Promise<IFileInfo> {
  const service = await resolve(FileInfoService);
  return service.getInfo(path);
}

/**
 * Calculates file hash
 * @param path  abs path to file
 * @returns
 */
export async function fileHash(path: string): Promise<string> {
  const hasher = await resolve(FileHasher);
  return hasher.hash(path);
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
export async function exists(path: string, fileSystem?: string | fs): Promise<boolean> {
  const p = _check_arg(_is_string(), _trim(), _non_empty())(path, 'path');

  if (fileSystem !== undefined) {
    return provider(fileSystem).exists(p);
  }

  return new Promise<boolean>((res) => {
    access(p, constants.F_OK, (error) => {
      res(!error);
    });
  });
}

/**
 * Reads whole file content through a filesystem provider.
 *
 * @param path path relative to provider base
 * @param encoding optional encoding ( raw Buffer when omitted )
 * @param fileSystem provider name / instance, or default provider
 */
export async function read(path: string, encoding?: BufferEncoding, fileSystem?: string | fs): Promise<string | Buffer> {
  return provider(fileSystem).read(path, encoding);
}

/**
 * Writes data to a file through a filesystem provider.
 */
export async function write(path: string, data: string | Uint8Array, encoding?: BufferEncoding, fileSystem?: string | fs): Promise<void> {
  return provider(fileSystem).write(path, data, encoding);
}

/**
 * Appends data to a file through a filesystem provider.
 */
export async function append(path: string, data: string | Uint8Array, encoding?: BufferEncoding, fileSystem?: string | fs): Promise<void> {
  return provider(fileSystem).append(path, data, encoding);
}

/**
 * Copies a file / dir, optionally into another filesystem.
 *
 * @param src source path ( relative to srcFs )
 * @param dst destination path
 * @param srcFs source provider name / instance ( default provider when omitted )
 * @param dstFs optional destination provider - copy within srcFs when omitted
 */
export async function copy(src: string, dst: string, srcFs?: string | fs, dstFs?: string | fs): Promise<void> {
  return provider(srcFs).copy(src, dst, dstFs ? provider(dstFs) : undefined);
}

/**
 * Moves a file / dir, optionally into another filesystem.
 */
export async function move(src: string, dst: string, srcFs?: string | fs, dstFs?: string | fs): Promise<void> {
  return provider(srcFs).move(src, dst, dstFs ? provider(dstFs) : undefined);
}

/**
 * Renames a file within a single filesystem.
 */
export async function rename(oldPath: string, newPath: string, fileSystem?: string | fs): Promise<void> {
  return provider(fileSystem).rename(oldPath, newPath);
}

/**
 * Removes a file or a directory ( recursively ).
 */
export async function rm(path: string, fileSystem?: string | fs): Promise<void> {
  return provider(fileSystem).rm(path);
}

/**
 * Creates a directory ( recursively ).
 */
export async function mkdir(path: string, fileSystem?: string | fs): Promise<void> {
  return provider(fileSystem).mkdir(path);
}

/**
 * Lists directory content.
 */
export async function list(path: string, fileSystem?: string | fs): Promise<string[]> {
  return provider(fileSystem).list(path);
}

/**
 * Returns file / dir statistics.
 */
export async function stat(path: string, fileSystem?: string | fs): Promise<IStat> {
  return provider(fileSystem).stat(path);
}

/**
 * Checks if a path is an existing directory.
 */
export async function dirExists(path: string, fileSystem?: string | fs): Promise<boolean> {
  return provider(fileSystem).dirExists(path);
}

/**
 * Checks if a path is a directory.
 */
export async function isDir(path: string, fileSystem?: string | fs): Promise<boolean> {
  return provider(fileSystem).isDir(path);
}

/**
 * Downloads a file to local storage and returns the local path.
 */
export async function download(path: string, fileSystem?: string | fs): Promise<string> {
  return provider(fileSystem).download(path);
}

/**
 * Uploads a local file into a filesystem provider.
 */
export async function upload(srcPath: string, dstPath?: string, fileSystem?: string | fs): Promise<void> {
  return provider(fileSystem).upload(srcPath, dstPath);
}

/**
 * Hashes a file through a filesystem provider.
 */
export async function hash(path: string, algo?: string, fileSystem?: string | fs): Promise<string> {
  return provider(fileSystem).hash(path, algo);
}

/**
 * Detects file type from content, throws IOFail when it cannot be determined.
 *
 * @param requested description of the expected type, used in the error message
 */
async function detectFileType(path: string, requested: string) {
  const { fileTypeFromFile } = await import('file-type');
  const type = await fileTypeFromFile(path);

  if (!type) {
    throw new IOFail(`File ${path} is invalid. Cannot determine file type, requested ${requested}`);
  }

  return type;
}

/**
 * Throws IOFail when file extension ( detected from content ) does not match.
 */
export async function isOfType(path: string, extension: string): Promise<void> {
  const type = await detectFileType(path, `extension is ${extension}`);

  if (type.ext !== extension) {
    throw new IOFail(`File ${path} is invalid. Requested extension is ${extension}, file mime type is ${type.ext}`);
  }
}

/**
 * Throws IOFail when file mime type ( detected from content ) does not match.
 */
export async function isOfMimetype(path: string, mimetype: string): Promise<void> {
  const type = await detectFileType(path, `mime type is ${mimetype}`);

  if (type.mime !== mimetype) {
    throw new IOFail(`File ${path} is invalid. Requested mime type is ${mimetype}, file mime type is ${type.mime}`);
  }
}

/**
 * Reads a local file content ( node fs.readFile wrapper ).
 */
export async function readFile(
  path: string,
  options?:
    | ({
        encoding?: null | undefined;
        flag?: string | undefined;
      } & Abortable)
    | undefined
    | null,
): Promise<Buffer> {
  _check_arg(_is_string(), _trim(), _non_empty())(path, 'path');

  return new Promise((res, reject) => {
    nodeReadFile(path, options, (error, data: Buffer) => {
      if (error) {
        reject(error);
        return;
      }
      res(data);
    });
  });
}
