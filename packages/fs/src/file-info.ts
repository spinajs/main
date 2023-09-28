import { spawn } from "node:child_process";

import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { IOFail } from '@spinajs/exceptions';
import { existsSync } from 'fs';
import { FileInfoService, IFileInfo } from './interfaces.js';
import { DateTime } from "luxon";



const EXIFTOOL_MAPPINGS = {
  audioChannels: "AudioChannels",
  imageHeight: 'Height',
  imageWidth: 'Width',
  duration: 'Duration',
  playDuration: 'Duration',
  frameCount: 'FrameCount',
  frameRate: 'FrameRate',
  videoFrameRate: 'FrameRate',
  maxBitrate: 'Bitrate',
  maxDataRate: 'Bitrate',
  avgBitrate: 'Bitrate',
  compressorID: 'Codec',
  fileSize: ["FileSize", (val: string) => (parseInt(val))],

  'fileAccessDate/Time': ["AccessDate", (val: string) => { return DateTime.fromFormat(val, "yyyy:MM:dd HH:mm:ssZZ") }],
  'fileCreationDate/Time': ["CreationDate", (val: string) => { return DateTime.fromFormat(val, "yyyy:MM:dd HH:mm:ssZZ") }],
  'fileModificationDate/Time': ["ModificationDate", (val: string) => { return DateTime.fromFormat(val, "yyyy:MM:dd HH:mm:ssZZ") }],

  mimeType: "MimeType",
  mimeEncoding: "Encoding",
  wordCount: "WordCount",
  lineCount: "LineCount"
};

function _fInfoInit(): IFileInfo {
  return {
    FileSize: null,
    Height: null,
    Width: null,
    Duration: null,
    FrameCount: null,
    FrameRate: null,
    Bitrate: null,
    Codec: null,
    Raw: null
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
    fInfo.Raw = metadata;

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

  protected async spawnExifProcess(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const process = spawn("exiftool", [file, "-n"]);
      let stdOutBuffer = "";
      let stdErrBuffer = "";

      process.on("error", (err: Error) => (reject(err)));
      process.on("close", () => (stdErrBuffer ? reject(stdErrBuffer) : resolve(stdOutBuffer)));
      process.stdout.on("data", (data: Buffer) => (stdOutBuffer += data.toString("utf-8")));
      process.stderr.on("data", (data: Buffer) => (stdErrBuffer += data.toString("utf-8")));
    });
  }

  protected async getMetadata(file: string) {

    const raw = await this.spawnExifProcess(file);

    // Split the response into lines.
    const response = raw.split("\n");

    //For each line of the response extract the meta data into a nice associative array
    const metaData: {
      [key: string]: string | number
    } = {};

    response.forEach(function (responseLine) {
      var pieces = responseLine.split(": ");
      //Is this a line with a meta data pair on it?
      if (pieces.length == 2) {
        //Turn the plain text data key into a camel case key.
        var key = pieces[0].trim().split(' ').map(
          function (tokenInKey, tokenNumber) {
            if (tokenNumber === 0)
              return tokenInKey.toLowerCase();
            else
              return tokenInKey[0].toUpperCase() + tokenInKey.slice(1);
          }
        ).join('');
        //Trim the value associated with the key to make it nice.
        var value = pieces[1].trim();

        if (+value === +value) {
          metaData[key] = parseFloat(value);
        } else {
          metaData[key] = value;
        }
      }
    });

    return metaData;
  }
}
