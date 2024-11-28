import { _resolve } from '@spinajs/di';
import { FileInfoService, fs } from './interfaces.js';
import { _chain, _use } from '@spinajs/util';

/**
 * Gets filesystem by its name
 *
 * @param name filesystem name ( must be defined in config file)
 * @returns
 */
export function _fs(name: string) {
  return _resolve('__file_provider__', [name]);
}

/**
 *
 * Zips files to file
 *
 * @param files files or dirs to zip
 * @param dstName
 * @returns absolute path to zipped file
 */
// export function _zip(files: string[], dstName: string) {

// }


// export function _unzip(file: string, dst :string) {

// }

/**
 *
 * Gets file information ( extended file information eg. movie fps, coded etc.)
 *
 * @param path abs path to file
 * @returns
 */
export function _fileInfo() {
  return (path: string) => {
    return _chain(_use(_resolve(FileInfoService), 'fileInfo'), ({ fileInfo }: { fileInfo: FileInfoService }) => {
      return fileInfo.getInfo(path);
    });
  };
}
