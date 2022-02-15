import { InternalLogger } from "@spinajs/internal-logger";
/* eslint security/detect-non-literal-fs-filename:0 -- Safe as no value holds user input */

import { Injectable, NewInstance } from "@spinajs/di";
import { LogTarget } from "./LogTarget";
import { IFileTargetOptions, ILogEntry } from "@spinajs/log-common";
import * as fs from "fs";
import * as path from "path";
import { Job, scheduleJob } from "node-schedule";
import { InvalidOption } from "@spinajs/exceptions";
import { EOL } from "os";
import * as glob from "glob";
import * as zlib from "zlib";
import { format } from "@spinajs/configuration";

@NewInstance()
export class FileTarget extends LogTarget<IFileTargetOptions> {
  protected LogDirPath: string;
  protected LogFileName: string;
  protected LogPath: string;
  protected LogFileExt: string;
  protected LogBaseName: string;

  protected ArchiveDirPath: string;

  protected RotateJob: Job;
  protected ArchiveJob: Job;

  protected LogFileDescriptor: number;

  protected CurrentFileSize: number;
  protected BufferSize = 0;

  protected Buffer: any[] = [];

  public resolve() {
    this.Options.options = Object.assign(
      {
        compress: true,
        maxSize: 1024 * 1024,
        maxArchiveFiles: 5,
        bufferSize: 8 * 1024,
        flushTimeout: 10 * 1000,
      },
      this.Options.options
    );

    this.initialize();
    this.rotate();

    process.on("exit", () => {
      this.flush();

      if (this.LogFileDescriptor) {
        fs.closeSync(this.LogFileDescriptor);
      }
    });

    super.resolve();
  }

  public write(data: ILogEntry): Promise<void> {
    if (!this.Options.enabled) {
      return;
    }

    const result = format(data.Variables, this.Options.layout) + EOL;
    const bytes = Buffer.byteLength(result);

    this.BufferSize += bytes;

    this.Buffer.push(result);

    if (this.BufferSize > this.Options.options.bufferSize) {
      this.flush();
    }

    if (this.CurrentFileSize > this.Options.options.maxSize) {
      InternalLogger.debug(`File ${this.LogPath} exceeded log size ( current: ${this.CurrentFileSize}, max: ${this.Options.options.maxSize})`, "file-target");

      this.archive();
    }
  }

  protected archive() {
    const files = glob
      .sync(path.join(this.ArchiveDirPath, `archived_${this.LogBaseName}*{${this.LogFileExt},.gzip}`))
      .map((f) => {
        return {
          name: f,
          stat: fs.statSync(f),
        };
      })
      .sort((x) => x.stat.mtime.getTime());

    const newestFile = files.length !== 0 ? files[files.length - 1].name : undefined;
    const fIndex = newestFile ? parseInt(newestFile.substring(newestFile.lastIndexOf("_") + 1, newestFile.lastIndexOf("_") + 2), 10) + 1 : 1;
    const archPath = path.join(this.ArchiveDirPath, `archived_${this.LogBaseName}_${fIndex}${this.LogFileExt}`);

    this.flush();

    if (!fs.existsSync(this.LogPath)) {
      return;
    }

    fs.closeSync(this.LogFileDescriptor);
    fs.copyFileSync(this.LogPath, archPath);
    fs.unlinkSync(this.LogPath);

    this.initialize();

    if (this.Options.options.compress) {
      const zippedPath = path.join(this.ArchiveDirPath, `archived_${this.LogBaseName}_${fIndex}${this.LogFileExt}.gzip`);
      const zip = zlib.createGzip();
      const read = fs.createReadStream(archPath);
      const write = fs.createWriteStream(zippedPath);

      read.pipe(zip).pipe(write);

      write.on("finish", () => {
        read.close();
        zip.close();
        write.close();
        fs.unlink(archPath, () => {
          return;
        });
      });

      InternalLogger.debug(`Created archived compressed file at ${zippedPath}`, "file-target");
    } else {
      InternalLogger.debug(`Created archived file at ${archPath}`, "file-target");
    }

    if (files.length >= this.Options.options.maxArchiveFiles) {
      InternalLogger.debug(`Deleting old archive file ${files[0].name}`, "file-target");

      fs.unlink(files[0].name, () => {
        return;
      });
    }
  }

  protected flush() {
    if (!this.LogFileDescriptor || this.HasError || this.BufferSize === 0) {
      return;
    }

    fs.writeFileSync(this.LogFileDescriptor, this.Buffer.join());

    this.CurrentFileSize += this.BufferSize;
    this.Buffer = [];
    this.BufferSize = 0;
  }

  private rotate() {

    InternalLogger.debug(`Initializing rotating log files at schedule ${this.Options.options.rotate}`, "file-target");

    if (this.Options.options.rotate) {
      this.RotateJob = scheduleJob(`LogScheduleJob`, this.Options.options.rotate, () => {
        this.archive();
      });
    }
  }

  private initialize() {
    this.flush();

    if (this.LogFileDescriptor >= 0) {
      fs.closeSync(this.LogFileDescriptor);
      this.LogFileDescriptor = 0;
    }

    this.CurrentFileSize = 0;
    this.LogDirPath = path.dirname(path.resolve(format(null, this.Options.options.path)));
    this.ArchiveDirPath = this.Options.options.archivePath ? path.resolve(format(null, this.Options.options.archivePath)) : this.LogDirPath;
    this.LogFileName = format(null, path.basename(this.Options.options.path));
    this.LogPath = path.join(this.LogDirPath, this.LogFileName);

    const { name, ext } = path.parse(this.LogFileName);
    this.LogFileExt = ext;
    this.LogBaseName = name;

    if (!this.LogDirPath) {
      throw new InvalidOption("Missing LogDirPath log option");
    }

    if (!fs.existsSync(this.LogDirPath)) {
      fs.mkdirSync(this.LogDirPath);
    }

    if (this.ArchiveDirPath) {
      if (!fs.existsSync(this.ArchiveDirPath)) {
        fs.mkdirSync(this.ArchiveDirPath);
      }
    }

    if (fs.existsSync(this.LogPath)) {
      const { size } = fs.statSync(this.LogPath);
      this.CurrentFileSize = size;
    }

    this.LogFileDescriptor = fs.openSync(this.LogPath, "a");

    if (this.Options.options.flushTimeout !== 0) {
      setTimeout(() => {
        this.flush();
      }, this.Options.options.flushTimeout);
    }

    InternalLogger.debug(`Creating log file at path ${this.LogPath}`, "file-target");

    this.HasError = false;
    this.Error = null;
  }
}
