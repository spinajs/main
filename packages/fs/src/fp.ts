import { _resolve } from '@spinajs/di';
import { FileInfoService } from './interfaces.js';
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
