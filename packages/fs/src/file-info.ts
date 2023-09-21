import { spawn } from "node:child_process";

import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { IOFail } from '@spinajs/exceptions';
import { existsSync } from 'fs';
import { FileInfoService, IFileInfo } from './interfaces.js';
import { DateTime } from "luxon";



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
  fileSize: ["FileSize", (val: string) => { return parseInt(val.split(" ")[0]) }],

  'fileAccessDate/Time': ["AccessDate", (val: string) => { return DateTime.fromFormat(val, "yyyy:MM:dd HH:mm:ss") }],
  'fileCreationDate/Time': ["CreationDate", (val: string) => { return DateTime.fromFormat(val, "yyyy:MM:dd HH:mm:ss") }],
  'fileModificationDate/Time': ["ModificationDate", (val: string) => { return DateTime.fromFormat(val, "yyyy:MM:dd HH:mm:ss") }],

  mimeType: "MimeType",
  mimeEncoding: "Encoding",
  wordCount: "WordCount",
  lineCount: "LineCount"
};

function _fInfoInit(): IFileInfo {
  return {
    FileSize: 0,
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

        const mKey = (EXIFTOOL_MAPPINGS as any)[key];
        if (Array.isArray(mKey)) {
          (fInfo as any)[mKey[0]] = mKey[1](metadata[key]);
        } else {
          (fInfo as any)[(EXIFTOOL_MAPPINGS as any)[key]] = metadata[key];
        }
      }
    }
    return fInfo;
  }

  protected async _exif(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const process = spawn("exiftool", [file]);
      // eslint-disable-next-line prefer-const
      let stdOutBuffer = "";
      // eslint-disable-next-line prefer-const
      let stdErrBuffer = "";

      process.on("spawn", () => {
        this.Log.trace(`Server process spawned succesyfully`);
      });

      process.on("error", (err: Error) => {
        this.Log.error(err, `Server process spawn failed`);
        reject(err);
      });

      process.on("close", () => {
        this.Log.trace(`Server process finished}`);
        if (stdErrBuffer) {
          reject(new Error(stdErrBuffer));
        } else {
          resolve(stdOutBuffer);
        }
      });

      process.stdout.on("data", (data: Buffer) => {
        const evData = data.toString("utf8");

        this.Log.trace(`Received server message: ${evData}`);
        stdOutBuffer += evData;
      });

      process.stderr.on("data", (data: Buffer) => {
        const evData = data.toString("utf8");

        this.Log.error(`Received server message: ${evData}`);
        stdErrBuffer += evData;
      });
    });
  }

  protected async getMetadata(file: string) {

    const raw = await this._exif(file);
    const res: any = {};

    for (const a of raw.split('\r\n')) {
      const pair = a.split(":");
      res[pair[0].trim()] = pair[1].trim();
    }
    return res;
    // const _exifPromise = new Promise((resolve, reject) => {
    //   try {
    //     this.Log.trace(`Obtaining exif info of file at path ${file}...`);

    //     // exif.metadata(file, (err: Error, metadata: any) => {
    //     //   if (err || metadata.error) {
    //     //     this.Log.warn(`Exif info failed, reason: ${err.message ?? metadata.error}`);
    //     //     reject(err ?? metadata.error);
    //     //   } else {
    //     //     resolve(metadata);
    //     //   }
    //     // });
    //   } catch (err) {
    //     reject(err);
    //   }
    // });

    // return _exifPromise;
  }
}
