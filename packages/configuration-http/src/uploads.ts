import { rm } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { Autoinject, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { _fileHash, FileInfoService, getFs } from '@spinajs/fs';
import type { fs } from '@spinajs/fs';
import { DataValidator, ValidationFailed } from '@spinajs/validation';
import { configFileValidatorName, DbConfig, resolveConfigFileValidator } from '@spinajs/configuration-db-source';
import type { IConfigFileCandidate, IConfigurationFileOptions } from '@spinajs/configuration-db-source';
import type { IUploadedFile } from '@spinajs/http';

import { ConfigFileRejected, NotAFileEntry } from './errors.js';
import { checkFileRules, storedFileName } from './files.js';
import { formatValidationErrors, valueSchema } from './validation.js';

/** A file that passed every rule and sits on the entry's provider; `Value` still points at the previous one. */
export interface IAcceptedConfigFile {
  entry: DbConfig;
  /** `meta.file.fs` of the entry. */
  fs: string;
  /** Name on the provider, see `storedFileName`. */
  fileName: string;
  originalName: string;
  size: number;
  /** sha256 of the content, hex. */
  hash: string;
  /** Content-detected; empty when detection failed. */
  mimeType: string;
}

export function configFileOptions(entry: DbConfig): IConfigurationFileOptions {
  const options = entry.Type === 'file' ? entry.Meta?.file : undefined;
  if (!options?.fs) {
    throw new NotAFileEntry(`configuration entry '${entry.Slug}' is not a file entry`);
  }
  return options;
}

/**
 * The upload pipeline of a file entry, without a route: a project composes
 * `accept` -> its own record step -> `commit`, and `discard`s an accepted file it could not record.
 * Rejections are `ConfigFileRejected` / `NotAFileEntry` (400); a misdeclared entry (unregistered
 * validator or provider, uncompilable slug schema) is a plain `Error` (500).
 */
@Injectable()
export class ConfigFileUploads {
  @Autoinject()
  protected FileInfo!: FileInfoService;

  @Autoinject()
  protected Validator!: DataValidator;

  @Logger('configuration-http')
  protected Log!: Log;

  /** Validates and stores the multipart file; always removes the temp file, never touches `Value`. */
  public async accept(entry: DbConfig, file: IUploadedFile): Promise<IAcceptedConfigFile> {
    try {
      return await this.acceptFile(entry, file);
    } finally {
      await rm(file.OriginalFile.filepath, { force: true }).catch(() => undefined);
    }
  }

  /** Points `Value` at an accepted (or restored) stored name after the same schema check a PATCH gets. */
  public async commit(entry: DbConfig, fileName: string): Promise<DbConfig> {
    configFileOptions(entry);
    this.validateStoredName(entry, fileName);

    entry.Value = fileName as typeof entry.Value;
    await entry.update();

    return entry;
  }

  /** Removes an accepted file the project could not record. Best effort. */
  public async discard(accepted: IAcceptedConfigFile): Promise<void> {
    try {
      await getFs(accepted.fs).rm(accepted.fileName);
    } catch (err) {
      this.Log.warn(
        `Accepted file ${accepted.fileName} of '${accepted.entry.Slug}' was not removed: ${(err as Error).message}`,
      );
    }
  }

  private async acceptFile(entry: DbConfig, file: IUploadedFile): Promise<IAcceptedConfigFile> {
    const options = configFileOptions(entry);
    const localPath = file.OriginalFile.filepath;

    const candidate: IConfigFileCandidate = {
      localPath,
      originalName: file.Name,
      size: file.Size,
      mimeType: await this.detectMimeType(localPath),
    };

    const broken = checkFileRules(options, candidate);
    if (broken) {
      throw new ConfigFileRejected(broken);
    }

    if (options.validator) {
      await this.runValidator(entry, configFileValidatorName(options.validator), candidate);
    }

    const fileName = storedFileName(file.Name, DateTime.utc());
    this.validateStoredName(entry, fileName);

    const target = this.fileSystem(entry.Slug, options.fs);
    // same name within the same second - uploading would overwrite the file the entry points at
    if (await target.exists(fileName)) {
      throw new ConfigFileRejected(`File ${fileName} was uploaded a moment ago, try again`);
    }

    const hash = await _fileHash(localPath);
    await target.upload(localPath, fileName);

    return {
      entry,
      fs: options.fs,
      fileName,
      originalName: file.Name,
      size: file.Size,
      hash,
      mimeType: candidate.mimeType,
    };
  }

  /** An unparseable file makes the detector fail; for the upload that is an unknown type, not a server error. */
  private async detectMimeType(localPath: string): Promise<string> {
    try {
      return (await this.FileInfo.getInfo(localPath)).MimeType ?? '';
    } catch (err) {
      this.Log.warn(`Cannot detect the content type of an uploaded file: ${(err as Error).message}`);
      return '';
    }
  }

  private async runValidator(entry: DbConfig, name: string, candidate: IConfigFileCandidate): Promise<void> {
    const validator = await resolveConfigFileValidator(name);
    if (!validator) {
      throw new Error(`configuration file validator '${name}' of '${entry.Slug}' is not registered`);
    }

    try {
      await validator.validate(candidate, entry);
    } catch (err) {
      if (err instanceof ValidationFailed) {
        throw new ConfigFileRejected(err.message);
      }
      throw err;
    }
  }

  private fileSystem(slug: string, provider: string): fs {
    try {
      return getFs(provider);
    } catch (err) {
      throw new Error(
        `file provider '${provider}' of configuration entry '${slug}' is not registered: ${(err as Error).message}`,
      );
    }
  }

  /**
   * The stored name is a `Value` and must satisfy the same schema a PATCH would: the entry type,
   * its meta, and the schema registered under the slug when there is one. A schema that only passed
   * the meta-schema check at startup can still fail strict compilation here - reported, not skipped.
   */
  private validateStoredName(entry: DbConfig, fileName: string): void {
    let schemaRef: string | undefined;
    try {
      schemaRef = this.Validator.hasSchema(entry.Slug) ? entry.Slug : undefined;
    } catch (err) {
      throw new Error(`configuration schema '${entry.Slug}' cannot be compiled: ${(err as Error).message}`);
    }

    const [isValid, errors] = this.Validator.tryValidate(
      { type: 'object', properties: { Value: valueSchema(entry.Type, entry.Meta, schemaRef) }, required: ['Value'] },
      { Value: fileName },
    );
    if (!isValid) {
      throw new ConfigFileRejected(formatValidationErrors('Value', errors));
    }
  }
}
