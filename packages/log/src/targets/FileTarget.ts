/* eslint-disable security/detect-object-injection */
import { EOL } from "os";
/* eslint security/detect-non-literal-fs-filename:0 -- Safe as no value holds user input */
import { IInstanceCheck, Injectable, PerInstanceCheck } from "@spinajs/di";
import {
  IFileTargetOptions,
  ILog,
  ILogEntry,
  LogTarget,
} from "@spinajs/log-common";
import * as fs from "fs";
import * as path from "path";
import { InvalidOption } from "../../../exceptions/lib/index.js";
import * as glob from "glob";
import * as zlib from "zlib";
import { format } from "@spinajs/configuration";
import { pipeline } from "stream";
import { Logger } from "./../decorators.js";
import "@spinajs/configuration-common";

enum FileTargetStatus {
  WRITTING,
  PENDING,
  IDLE,
}

// we mark per instance check becouse we can have multiple file targes
// for different files/paths/logs but we dont want to create every time writer for same.
@PerInstanceCheck()
@Injectable("FileTarget")
export class FileTarget
  extends LogTarget<IFileTargetOptions>
  implements IInstanceCheck
{
  @Logger("LogFileTarget")
  protected Log: ILog;

  public LogDirPath: string;
  public ArchiveDirPath: string;

  protected WriteStream: fs.WriteStream;
  protected Buffer: string[] = [];

  protected ArchiveTimer: NodeJS.Timer;
  protected FlushTimer: NodeJS.Timer;

  protected Status: FileTargetStatus = FileTargetStatus.IDLE;
  protected ArchiveStatus: FileTargetStatus = FileTargetStatus.IDLE;

  __checkInstance__(creationOptions: IFileTargetOptions): boolean {
    return this.Options.name === creationOptions.name;
  }

  public resolve() {
    this.Options.options = Object.assign(
      {
        compress: true,
        maxSize: 1024 * 1024,
        maxArchiveFiles: 5,
        archiveInterval: 3 * 60,
      },
      this.Options.options
    );

    this.LogDirPath = path.dirname(
      path.resolve(format(null, this.Options.options.path))
    );
    this.ArchiveDirPath = this.Options.options.archivePath
      ? path.resolve(format(null, this.Options.options.archivePath))
      : this.LogDirPath;

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

    // flush all buffered messages at least once per second
    // we do this, becouse buffer can not be filled
    // and we could wait unknown amount of time before messages are written to file
    this.FlushTimer = setInterval(() => {
      // do not flush, if we already writting to file
      if (
        this.Status !== FileTargetStatus.IDLE &&
        this.ArchiveStatus !== FileTargetStatus.IDLE
      ) {
        return;
      }

      setImmediate(() => {
        this.flush();
      });
    }, 1000);

    // every 3 minutes try to archive log files
    this.ArchiveTimer = setInterval(() => {
      // do not archive if we already doing it
      if (
        this.Status !== FileTargetStatus.IDLE &&
        this.ArchiveStatus !== FileTargetStatus.IDLE
      ) {
        return;
      }

      this.ArchiveStatus = FileTargetStatus.PENDING;

      // at end of nodejs event loop
      setImmediate(() => {
        this.archive();
      });
    }, this.Options.options.archiveInterval * 1000);

    super.resolve();
  }

  protected flush() {
    if (this.Buffer.length === 0) {
      this.Status = FileTargetStatus.IDLE;
      return;
    }

    this.Status = FileTargetStatus.WRITTING;

    // we calculate log path every time to allow for
    // dynamic path creation eg. based on timestamp
    const logFileName = format(
      { logger: this.Options.name },
      path.basename(this.Options.options.path)
    );
    const logPath = path.join(this.LogDirPath, logFileName);

    fs.appendFile(logPath, this.Buffer.join(EOL) + EOL, (err) => {
      // log error message to others if applicable eg. console
      if (err) {
        this.Log.error(
          err,
          `Cannot write log messages to file target at path ${logPath}`
        );
      }

      this.Log.trace(
        `Wrote buffered messages to log file at path ${logPath}, buffer size: ${this.Options.options.maxBufferSize}`
      );

      this.Buffer = [];
      this.Status = FileTargetStatus.IDLE;
    });
  }

  public async dispose() {
    // stop archiving
    clearInterval(this.ArchiveTimer);

    // stop flush timer
    clearInterval(this.FlushTimer);

    // write all messages from buffer
    this.flush();
  }

  public async write(data: ILogEntry) {
    if (!this.Options.enabled) {
      return;
    }

    const lEntry = format(data.Variables, this.Options.layout);

    this.Buffer.push(lEntry);

    // if we already writting, skip buffer check & write to file
    // wait until write is finished
    if (
      this.Status !== FileTargetStatus.IDLE ||
      this.ArchiveStatus !== FileTargetStatus.IDLE
    ) {
      return;
    }

    if (this.Buffer.length >= this.Options.options.maxBufferSize) {
      this.Status = FileTargetStatus.PENDING;

      // write at end of nodejs event loop all buffered messages at once
      setImmediate(() => {
        this.flush();
      });
    }
  }

  protected archive() {
    const { ext } = path.parse(path.basename(this.Options.options.path));

    const aFiles = glob
      .sync(path.join(this.ArchiveDirPath, `archived_*{${ext},.gzip}`))
      .map((f: string) => {
        return {
          name: f,
          stat: fs.statSync(f),
        };
      })
      .sort((a, b) => a.stat.mtime.getTime() - b.stat.mtime.getTime());

    const lFiles = glob
      .sync(path.join(this.LogDirPath, `*${ext}`))
      .map((f: string) => {
        return {
          name: f,
          stat: fs.statSync(f),
        };
      })
      .sort((a, b) => a.stat.mtime.getTime() - b.stat.mtime.getTime());

    // clear archived files above limit
    if (aFiles.length > this.Options.options.maxArchiveFiles) {
      for (
        let i = 0;
        i < aFiles.length - this.Options.options.maxArchiveFiles;
        i++
      ) {
        fs.unlink(aFiles[i].name, (err) => {
          if (err) {
            this.Log.error(
              err,
              `Cannot delete archived file at path ${aFiles[i - 1].name}`
            );
          } else {
            this.Log.info(`Deleted archived file at path ${aFiles[i].name}`);
          }
        });
      }
    }

    // now move log files that are above limited file size or old
    const filesToArchive = lFiles.filter((x) => {
      return (
        x.stat.size > this.Options.options.maxSize ||
        lFiles.indexOf(x) <= lFiles.length - 2
      );
    });

    if (filesToArchive.length === 0) {
      this.ArchiveStatus = FileTargetStatus.IDLE;
    }

    for (let i = 0; i < filesToArchive.length; i++) {
      const { name, ext } = path.parse(path.basename(lFiles[i].name));

      // get number of files with same name, eg. during a day, multiple log files can be produced
      const lArchiFiles = glob.sync(
        path
          .join(this.ArchiveDirPath, `archived_${name}*{${ext},.gzip}`)
          .replace(/\\/g, "/")
      );
      const archPath = path.join(
        this.ArchiveDirPath,
        `archived_${name}_${lArchiFiles.length + 1}${ext}`
      );

      fs.rename(lFiles[i].name, archPath, (err) => {
        if (err) {
          this.Log.error(
            err,
            `Cannot move log file ${name} to archive at path ${archPath}`
          );
          return;
        }

        if (this.Options.options.compress) {
          this.Log.trace(`Compressing archive log at path ${archPath}`);

          const zippedPath = path.join(
            this.ArchiveDirPath,
            `archived_${name}_${lArchiFiles.length + 1}${ext}.gzip`
          );
          const zip = zlib.createGzip();
          const read = fs.createReadStream(archPath);
          const write = fs.createWriteStream(zippedPath);

          pipeline(read, zip, write, (err) => {
            if (err) {
              this.Log.error(
                err,
                `Cannot compress archived file at path ${archPath}`
              );
              fs.unlink(zippedPath, () => {
                return;
              });

              return;
            }

            this.Log.info(
              `Succesyfully compressed archive log at path ${zippedPath}`
            );

            fs.unlink(archPath, (err) => {
              if (err) {
                this.Log.error(
                  err,
                  `Cannot delete archived log after compression at path ${archPath}`
                );
              }
            });

            this.ArchiveStatus = FileTargetStatus.IDLE;
          });
        } else {
          this.ArchiveStatus = FileTargetStatus.IDLE;
        }
      });
    }
  }
}
