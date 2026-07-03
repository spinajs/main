/// <reference path="./typings/exiftool.d.ts" />
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';

import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log-common';
import { IOFail } from '@spinajs/exceptions';
import { existsSync } from 'fs';
import { FileInfoService, IFileInfo } from './interfaces.js';
import { DateTime } from 'luxon';

/**
 * Default process timeout ( ms ) for the exiftool invocation.
 */
const DEFAULT_TIMEOUT = 30_000;

/**
 * Default exiftool arguments. `-n` disables print-conversion ( numeric values ).
 * Extend via the `fs.fileInfo.args` configuration ( eg. add `-a`, `-G`, `-ee`,
 * `-All` ) to widen what is extracted.
 */
const DEFAULT_ARGS = ['-n'];

/**
 * A single extracted metadata value.
 */
type ExifValue = string | number | DateTime;

/**
 * Friendly aliases: normalised exiftool tag -> {@link IFileInfo} field name.
 *
 * This is NOT an allow-list - every tag emitted by exiftool is extracted and
 * promoted ( see {@link DefaultFileInfo.toFileInfo} ). Aliases only give the
 * most common tags stable, typed names and keep existing consumers working.
 * Several source tags may collapse onto one field ( eg. duration / playDuration ).
 */
const TAG_ALIASES: Record<string, string> = {
  imageWidth: 'Width',
  imageHeight: 'Height',
  duration: 'Duration',
  playDuration: 'Duration',
  frameCount: 'FrameCount',
  frameRate: 'FrameRate',
  videoFrameRate: 'FrameRate',
  audioChannels: 'AudioChannels',
  maxBitrate: 'Bitrate',
  maxDataRate: 'Bitrate',
  avgBitrate: 'Bitrate',
  compressorID: 'Codec',
  fileSize: 'FileSize',
  mimeType: 'MimeType',
  mimeEncoding: 'Encoding',
  wordCount: 'WordCount',
  lineCount: 'LineCount',
  fileAccessDateTime: 'AccessDate',
  fileCreationDateTime: 'CreationDate',
  fileModificationDateTime: 'ModificationDate',
};

/**
 * Matches the leading part of an exiftool date value, eg. `2024:01:15 10:30:45`.
 */
const EXIFTOOL_DATE = /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/;

/**
 * Date formats exiftool may emit ( with/without sub-seconds and timezone ).
 */
const EXIFTOOL_DATE_FORMATS = [
  'yyyy:MM:dd HH:mm:ssZZ',
  'yyyy:MM:dd HH:mm:ss.SSSZZ',
  'yyyy:MM:dd HH:mm:ss.SSS',
  'yyyy:MM:dd HH:mm:ss',
];

/**
 * Normalises a raw exiftool tag name ( eg. "Image Width", "File
 * Modification Date/Time" ) into a stable camelCase key ( "imageWidth",
 * "fileModificationDateTime" ) by splitting on any non-alphanumeric run.
 */
function normalizeTag(rawTag: string): string {
  return rawTag
    .split(/[^a-zA-Z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token, index) => (index === 0 ? token.toLowerCase() : token[0].toUpperCase() + token.slice(1)))
    .join('');
}

/**
 * Coerces a raw exiftool string value into a typed value: date-shaped strings
 * become {@link DateTime} ( detected by value shape, not by a hardcoded field
 * list ), purely numeric strings become numbers, everything else stays a string.
 */
function coerceValue(value: string): ExifValue {
  if (EXIFTOOL_DATE.test(value)) {
    for (const format of EXIFTOOL_DATE_FORMATS) {
      const parsed = DateTime.fromFormat(value, format);
      if (parsed.isValid) {
        return parsed;
      }
    }
  }

  if (value !== '' && +value === +value) {
    return parseFloat(value);
  }

  return value;
}

/**
 * Resolves the path to the exiftool binary.
 *
 * Prefers the vendored binary shipped with the `exiftool-vendored` platform
 * packages ( no system installation required ), and falls back to `exiftool`
 * available on PATH.
 */
export async function resolveExifToolPath(): Promise<string> {
  try {
    const mod = process.platform === 'win32' ? await import('exiftool-vendored.exe') : await import('exiftool-vendored.pl');
    const binaryPath = (mod.default ?? mod) as unknown as string;

    if (typeof binaryPath === 'string' && existsSync(binaryPath)) {
      return binaryPath;
    }
  } catch {
    /* vendored package not installed for this platform - fall back to PATH */
  }

  return 'exiftool';
}

/**
 * Default {@link FileInfoService} implementation backed by the `exiftool`
 * command line tool.
 *
 * The binary is auto-resolved ( vendored, then PATH ) unless overridden with
 * the `fs.fileInfo.exifToolPath` configuration key. The invocation is bounded
 * by the `fs.fileInfo.timeout` configuration ( default {@link DEFAULT_TIMEOUT} ).
 */
@Injectable(FileInfoService)
export class DefaultFileInfo extends FileInfoService {
  @Logger('fs')
  protected Log!: Log;

  /**
   * Optional exiftool binary path override from configuration. When unset, the
   * binary is auto-resolved via {@link resolveExifToolPath}.
   */
  @Config('fs.fileInfo.exifToolPath')
  protected ConfiguredPath?: string;

  /**
   * Timeout ( ms ) for the exiftool process, from configuration.
   */
  @Config('fs.fileInfo.timeout', { defaultValue: DEFAULT_TIMEOUT })
  protected Timeout!: number;

  /**
   * exiftool arguments controlling extraction breadth, from configuration
   * ( default {@link DEFAULT_ARGS} ). The file spec ( path or `-` ) is appended
   * automatically. NOTE: some flags ( eg. `-G` ) change the output tag names.
   */
  @Config('fs.fileInfo.args', { defaultValue: DEFAULT_ARGS })
  protected ExifArgs!: string[];

  /**
   * Auto-resolved exiftool binary path, cached after first use.
   */
  protected ExifToolPath!: string;

  /**
   * Extracts file information from a file on disk.
   *
   * @param pathToFile absolute path to the file
   * @throws {IOFail} when the file does not exist or exiftool fails
   */
  public async getInfo(pathToFile: string): Promise<IFileInfo> {
    if (!existsSync(pathToFile)) {
      throw new IOFail(`Path ${pathToFile} not exists`);
    }

    const raw = await this.runExifTool(pathToFile);
    return this.toFileInfo(this.parseMetadata(raw));
  }

  /**
   * Extracts file information from a readable stream by piping its content to
   * exiftool via stdin ( `exiftool -n -` ).
   *
   * @param stream readable stream with the file content
   * @throws {IOFail} when exiftool fails or the stream errors
   */
  public async getInfoFromStream(stream: NodeJS.ReadableStream): Promise<IFileInfo> {
    const raw = await this.runExifTool('-', stream);
    return this.toFileInfo(this.parseMetadata(raw));
  }

  /**
   * Resolves the exiftool binary path, preferring the configured override.
   */
  protected async binaryPath(): Promise<string> {
    if (this.ConfiguredPath) {
      return this.ConfiguredPath;
    }

    if (!this.ExifToolPath) {
      this.ExifToolPath = await resolveExifToolPath();
      this.Log.trace(`Using exiftool binary: ${this.ExifToolPath}`);
    }

    return this.ExifToolPath;
  }

  /**
   * Spawns the exiftool process. Extracted so it can be overridden ( eg. in tests ).
   */
  protected spawnExif(binary: string, args: string[]): ChildProcessWithoutNullStreams {
    return spawn(binary, args);
  }

  /**
   * Runs exiftool against a file spec ( a path, or `-` for stdin ) and returns
   * its stdout.
   *
   * Success/failure is determined by the process exit code ( not by the mere
   * presence of stderr, which exiftool uses for non-fatal warnings ). The call
   * is bounded by {@link Timeout} and any failure is surfaced as {@link IOFail}.
   *
   * @param fileArg file path or `-` to read from stdin
   * @param input optional readable stream piped to the process stdin
   */
  protected async runExifTool(fileArg: string, input?: NodeJS.ReadableStream): Promise<string> {
    const binary = await this.binaryPath();
    const child = this.spawnExif(binary, [...this.ExifArgs, fileArg]);

    return new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new IOFail(`exiftool timed out after ${this.Timeout}ms`)));
      }, this.Timeout);

      child.on('error', (err) => finish(() => reject(new IOFail(`Cannot run exiftool ( ${binary} )`, err))));
      child.on('close', (code) =>
        finish(() =>
          code === 0
            ? resolve(stdout)
            : reject(new IOFail(`exiftool exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`)),
        ),
      );
      child.stdout.on('data', (data: Buffer) => (stdout += data.toString('utf-8')));
      child.stderr.on('data', (data: Buffer) => (stderr += data.toString('utf-8')));

      if (input) {
        input.on('error', (err) =>
          finish(() => {
            child.kill('SIGKILL');
            reject(new IOFail('Error reading input stream for exiftool', err));
          }),
        );
        input.pipe(child.stdin);
      }
    });
  }

  /**
   * Parses raw exiftool text output into a `{ normalisedTag: value }` map with
   * EVERY emitted tag ( nothing is filtered ).
   *
   * Each line is split on the FIRST `': '` only, so values that themselves
   * contain `': '` are preserved. Values are coerced by {@link coerceValue}
   * ( numbers and date-shaped strings ).
   */
  protected parseMetadata(raw: string): Record<string, ExifValue> {
    const metaData: Record<string, ExifValue> = {};

    for (const line of raw.split('\n')) {
      const sep = line.indexOf(': ');
      if (sep === -1) {
        continue;
      }

      const rawKey = line.slice(0, sep).trim();
      const value = line.slice(sep + 2).trim();
      if (!rawKey) {
        continue;
      }

      metaData[normalizeTag(rawKey)] = coerceValue(value);
    }

    return metaData;
  }

  /**
   * Projects a parsed metadata map onto {@link IFileInfo}.
   *
   * Every extracted tag is promoted: known tags via their {@link TAG_ALIASES}
   * friendly field name, all others under their PascalCased tag name. The full
   * unmodified map is always available under `Raw`.
   */
  protected toFileInfo(metadata: Record<string, ExifValue>): IFileInfo {
    const fInfo: IFileInfo = { FileSize: 0 };

    for (const tag in metadata) {
      const field = TAG_ALIASES[tag] ?? tag[0].toUpperCase() + tag.slice(1);
      fInfo[field] = metadata[tag];
    }

    // set Raw last so a stray `Raw` tag can never clobber the full map
    fInfo.Raw = metadata;

    return fInfo;
  }
}
