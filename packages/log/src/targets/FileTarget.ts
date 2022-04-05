import { EOL } from "os";
/* eslint security/detect-non-literal-fs-filename:0 -- Safe as no value holds user input */
import { Injectable, NewInstance } from "@spinajs/di";
import { createLogMessageObject, IFileTargetOptions, ILogEntry, LogLevel, LogTarget } from "@spinajs/log-common";
import * as fs from "fs";
import * as path from "path";
import { Job, scheduleJob } from "node-schedule";
import { InvalidOption } from "@spinajs/exceptions";
import * as glob from "glob";
import * as zlib from "zlib";
import { format } from "@spinajs/configuration";
import { pipeline, Readable } from "stream";

class FileLogStream extends Readable {
  protected LogQueue: string[] = [];

  public enqueue(entry: string) {
    this.LogQueue.push(entry);
  }

  public _read(): void {
    let ok = true;
    let val = null;
    do {
      val = this.LogQueue.shift();
      if (val) {
        ok = this.push(val);
      }
    } while (ok && val);
  }
}

@NewInstance()
@Injectable("FileTarget")
export class FileTarget extends LogTarget<IFileTargetOptions> {
  public LogDirPath: string;
  public LogFileName: string;
  public LogPath: string;
  public LogFileExt: string;
  public LogBaseName: string;

  public ArchiveDirPath: string;

  protected RotateJob: Job;
  protected CurrentFileSize: number;
  protected IsArchiving = false;

  protected WriteStream: fs.WriteStream;
  protected LogStream: FileLogStream;

  public async resolve() {
    this.Options.options = Object.assign(
      {
        compress: true,
        maxSize: 1024 * 1024,
        maxArchiveFiles: 5,
      },
      this.Options.options
    );

    this.LogStream = new FileLogStream();

    this.initialize();
    this.rotate();
    super.resolve();
  }

  public async write(data: ILogEntry) {
    if (!this.Options.enabled) {
      return;
    }

    const lEntry = format(data.Variables, this.Options.layout) + EOL;
    this.LogStream.enqueue(lEntry);

    if (this.CurrentFileSize + this.WriteStream.bytesWritten >= this.Options.options.maxSize && !this.IsArchiving) {
      this.archive();
    }
  }

  protected archive() {
    this.IsArchiving = true;

    const files = glob
      .sync(path.join(this.ArchiveDirPath, `archived_${this.LogBaseName}*{${this.LogFileExt},.gzip}`))
      .map((f: string) => {
        return {
          name: f,
          stat: fs.statSync(f),
        };
      })
      .sort((x) => x.stat.mtime.getTime());

    const newestFile = files.length !== 0 ? files[files.length - 1].name : undefined;
    const fIndex = newestFile ? parseInt(newestFile.substring(newestFile.lastIndexOf("_") + 1, newestFile.lastIndexOf("_") + 2), 10) + 1 : 1;
    const archPath = path.join(this.ArchiveDirPath, `archived_${this.LogBaseName}_${fIndex}${this.LogFileExt}`);

    if (!fs.existsSync(this.LogPath)) {
      return;
    }

    this.WriteStream.once("close", () => {
      fs.rename(this.LogPath, archPath, (err) => {
        this.initialize();

        if (!err) {
          if (this.Options.options.compress) {
            const zippedPath = path.join(this.ArchiveDirPath, `archived_${this.LogBaseName}_${fIndex}${this.LogFileExt}.gzip`);
            const zip = zlib.createGzip();
            const read = fs.createReadStream(archPath);
            const write = fs.createWriteStream(zippedPath);

            pipeline(read, zip, write, (err) => {
              if (err) {
                void this.write(createLogMessageObject(err, `Cannot compress log file at ${this.LogPath}`, LogLevel.Trace, "log-file-target", {}));
                fs.unlink(zippedPath, () => {
                  return;
                });
              }
              fs.unlink(archPath, () => {
                return;
              });
            });
          }

          if (files.length >= this.Options.options.maxArchiveFiles) {
            fs.unlink(files[0].name, () => {
              return;
            });
          }
        }
      });
    });
    this.close();
  }

  private rotate() {
    if (this.Options.options.rotate) {
      this.RotateJob = scheduleJob(`LogScheduleJob`, this.Options.options.rotate, () => {
        this.archive();
      });
    }
  }

  private initialize() {
    this.CurrentFileSize = 0;
    this.IsArchiving = false;
    this.LogDirPath = path.dirname(path.resolve(format(null, this.Options.options.path)));
    this.ArchiveDirPath = this.Options.options.archivePath ? path.resolve(format(null, this.Options.options.archivePath)) : this.LogDirPath;
    this.LogFileName = format({ logger: this.Options.name }, path.basename(this.Options.options.path));
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

    try {
      const { size } = fs.statSync(this.LogPath);
      this.CurrentFileSize = size;
    } catch {}

    this.open();
  }

  private close() {
    this.LogStream.unpipe(this.WriteStream);
    this.WriteStream.end();
    this.WriteStream = null;
  }

  private open() {
    this.WriteStream = fs.createWriteStream(this.LogPath, {
      flags: "a",
      encoding: "utf-8",
    });

    this.WriteStream.once("open", () => {
      void this.write(createLogMessageObject(`Log file opened at ${this.LogPath}`, [], LogLevel.Trace, "log-file-target", {}));

      if (this.WriteStream) {
        this.LogStream.pipe(this.WriteStream);
      }
    });

    this.WriteStream.once("close", () => {
      void this.write(createLogMessageObject(`Log file closed at ${this.LogPath}`, [], LogLevel.Trace, "log-file-target", {}));
    });

    this.WriteStream.once("error", (err: Error) => {
      this.LogStream.unpipe(this.WriteStream);
      void this.write(createLogMessageObject(err, `Cannot write to log file at ${this.LogPath}`, LogLevel.Error, "log-file-target", {}));

      setTimeout(() => {
        this.initialize();
      }, 1000);
    });
  }
}
