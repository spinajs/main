// @ts-ignore
import exif from 'exiftool';

import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { IOFail } from '@spinajs/exceptions';
import { existsSync } from 'fs';
import { FileInfoService, IFileInfo } from './interfaces.js';

const EXIFTOOL_MAPPINGS = {
  imageHeight: 'Height',
  imageWidth: 'Width',
  duration: 'Duration',
  playDuration: 'Duration',
  frameCount: 'FrameCount',
  frameRate: 'FrameRate',
  videoFrameRate: 'FrameRate',
  maxBitrate: 'Bitrate',
  maxDataRate: 'Bitrate',
  videoCodecName: 'Codec',
  videoCodec: 'Codec',
  compressorID: 'Compressor',
};

function _fInfoInit(): IFileInfo {
  return {
    Size: 0,
    Height: 0,
    Width: 0,
    Duration: 0,
    FrameCount: 0,
    FrameRate: 0,
    Bitrate: 0,
    Codec: null,
    Compressor: null,
  }
}

@Injectable(FileInfoService)
export class DefaultFileInfo extends FileInfoService {
  @Logger('fs')
  protected Log: Log;

  public async getInfo(pathToFile: string): Promise<IFileInfo> {
    if (!existsSync(pathToFile)) {
      throw new IOFail(`Path ${pathToFile} not exists`);
    }

    const fInfo = _fInfoInit();
    const metadata: any = await this.getMetadata(pathToFile);

    for (const key in EXIFTOOL_MAPPINGS) {
      if (metadata[key]) {
        (fInfo as any)[(EXIFTOOL_MAPPINGS as any)[key]] = metadata[key];
      }
    }
    return fInfo;
  }

  protected getMetadata(file: string) {
    const _exifPromise = new Promise((resolve, reject) => {
      try {
        this.Log.trace(`Obtaining exif info of file at path ${file}...`);

        exif.metadata(file, (err: Error, metadata: any) => {
          if (err || metadata.error) {
            this.Log.warn(`Exif info failed, reason: ${err.message ?? metadata.error}`);
            reject(err ?? metadata.error);
          } else {
            resolve(metadata);
          }
        });
      } catch (err) {
        reject(err);
      }
    });

    return _exifPromise;
  }
}
