import {
  BadRequestResponse,
  BaseController,
  BasePath,
  Body,
  File,
  FileResponse,
  Get,
  IUploadedFile,
  NotFound,
  Ok,
  Param,
  Patch,
  Policy,
  Post,
  Query,
  ServerError,
} from '@spinajs/http';
import { AuthorizedPolicy, Permission, Resource, User as CurrentUser } from '@spinajs/rbac-http';
import { User, userModel } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { DataValidator, ValidationFailed } from '@spinajs/validation';
import { FromModel } from '@spinajs/orm-http';
import { CONFIG_FILE_DEFAULT_MAX_SIZE, DbConfig, DbConfigFileHistory, IConfigFileCandidate, configFileValidatorName, resolveConfigFileValidator } from '@spinajs/configuration-db-source';
import { FileInfoService, getFs } from '@spinajs/fs';
import { Log, Logger } from '@spinajs/log';
import { DateTime } from 'luxon';
import { rm } from 'node:fs/promises';
import { UpdateConfigDto } from '../dto/update-config-dto.js';
import { formatValidationErrors, valueSchema } from '../validation.js';
import { fileExtension, sha256File, storedFileName } from '../files.js';

/**
 * Serializes an entry for the api. `DbConfig.dehydrate()` emits only the declared
 * columns with Value / Default in their canonical stored form ( numbers as "10",
 * booleans as "true"/"false", dates / times as ISO 8601 etc. ) produced by the
 * DbConfigValueConverter, and Meta already parsed into an object by its @Json
 * converter - the same representation they round-trip through on update.
 */
function present(entry: DbConfig) {
  const out = entry.dehydrate() as Record<string, unknown>;
  out.Meta = entry.Meta ?? null;
  return out;
}

function badRequest(message: string) {
  return new BadRequestResponse({ error: { message } });
}

interface IUploaderJson {
  Id: number;
  Email: string;
  Login: string;
}

/**
 * Built by hand: rbac `User` hides `Id` on dehydrate, and dates go out as UTC ISO strings.
 */
function presentHistoryRow(row: DbConfigFileHistory, uploader: IUploaderJson | null) {
  return {
    Id: row.Id,
    Slug: row.Slug,
    Fs: row.Fs,
    FileName: row.FileName,
    OriginalName: row.OriginalName,
    Size: row.Size,
    Hash: row.Hash,
    UploadedBy: row.UploadedBy,
    UploadedAt: row.UploadedAt ? row.UploadedAt.toUTC().toISO() : null,
    ArchivedPath: row.ArchivedPath ?? null,
    ArchivedAt: row.ArchivedAt ? row.ArchivedAt.toUTC().toISO() : null,
    Uploader: uploader,
  };
}

/**
 * HTTP api for database stored configuration values.
 *
 * Exposes read and update operations over the `configuration` table managed by
 * `@spinajs/configuration-db-source`. Entries themselves are created by code
 * that exposes config options ( `expose: true` ), so this api intentionally does
 * NOT allow creating or deleting arbitrary entries - only tuning their values.
 *
 * Writes are persisted to the database only. The running application picks up
 * the change through the db-source watch poll, and only for entries with
 * `Watch = true`.
 *
 * @tags Configuration
 */
@BasePath('configuration')
@Policy(AuthorizedPolicy)
@Resource('configuration')
export class ConfigurationController extends BaseController {
  @Autoinject()
  protected Validator!: DataValidator;

  @Autoinject()
  protected FileInfo!: FileInfoService;

  @Logger('configuration-http')
  protected Log!: Log;

  /**
   * List configuration entries
   * Returns all database stored configuration entries, optionally filtered by group.
   * @security cookieAuth
   * @param group Optional group name to filter entries by
   * @response 200 List of configuration entries
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on configuration resource
   */
  @Get('/')
  @Permission(['readAny'])
  public async list(@Query() group?: string) {
    const entries = await (group ? DbConfig.where('Group', group) : DbConfig.all());
    return new Ok(entries.map((e) => present(e)));
  }

  /**
   * Get configuration entry
   * Returns a single configuration entry identified by its slug.
   * @security cookieAuth
   * @param slug Unique configuration entry slug
   * @response 200 Configuration entry
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on configuration resource
   * @response 404 Configuration entry not found
   */
  @Get(':slug')
  @Permission(['readAny'])
  public async get(@FromModel({ paramField: 'slug', queryField: 'Slug' }) entry: DbConfig) {
    return new Ok(present(entry));
  }

  /**
   * Update configuration entry value
   * Updates the value ( and optionally default/watch flag ) of an existing entry.
   * The incoming value is validated against the entry `Type` and `Meta` constraints and,
   * when `@spinajs/validation` holds a schema whose `$id` equals the slug, against that schema.
   * Structural fields ( slug, group, type ) cannot be changed through this api.
   * @security cookieAuth
   * @param slug Unique configuration entry slug
   * @response 200 Updated configuration entry
   * @response 400 Invalid value for the entry type, constraints or registered schema
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on configuration resource
   * @response 404 Configuration entry not found
   * @response 500 Registered schema for this slug cannot be compiled
   */
  @Patch(':slug')
  @Permission(['updateAny'])
  public async update(@FromModel({ paramField: 'slug', queryField: 'Slug' }) entry: DbConfig, @Body() data: UpdateConfigDto) {
    const schema = this.entryValueSchema(entry);
    if (schema instanceof ServerError) {
      return schema;
    }

    const valueError = this.validateValue(schema, 'Value', data.Value);
    if (valueError) {
      return valueError;
    }

    if (data.Default !== undefined) {
      const defaultError = this.validateValue(schema, 'Default', data.Default);
      if (defaultError) {
        return defaultError;
      }
    }

    // Assign the raw, validated value(s). The DbConfigValueConverter does all the
    // type-based coercion into the canonical stored form on update().
    entry.Value = data.Value as typeof entry.Value;
    if (data.Default !== undefined) {
      entry.Default = data.Default as typeof entry.Default;
    }

    if (data.Watch !== undefined) {
      entry.Watch = data.Watch;
    }

    await entry.update();

    return new Ok(present(entry));
  }

  /**
   * Upload a file for a file entry
   * Checks the file against the entry's `Meta.file` rules and value schema, stores it in the entry's
   * fs provider under a timestamped name, points `Value` at it and records it in the upload history.
   * @security cookieAuth
   * @param slug Unique configuration entry slug
   * @response 200 Updated configuration entry
   * @response 400 Not a file entry, or the file breaks the size / extension / content type / validator / value schema rules
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on configuration resource
   * @response 404 Configuration entry not found
   * @response 500 Unregistered validator, or the upload could not be saved
   */
  @Post(':slug/file')
  @Permission(['updateAny'])
  public async uploadFile(@FromModel({ paramField: 'slug', queryField: 'Slug' }) entry: DbConfig, @File({ required: true }) file: IUploadedFile, @CurrentUser() user: User) {
    try {
      return await this.storeFile(entry, file, user);
    } finally {
      await rm(file.OriginalFile.filepath, { force: true });
    }
  }

  /**
   * Download the current file of a file entry
   * Streams the file named by the entry's `Value` from its fs provider.
   * @security cookieAuth
   * @param slug Unique configuration entry slug
   * @response 200 File content
   * @response 400 Not a file entry
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on configuration resource
   * @response 404 Configuration entry or file not found
   */
  @Get(':slug/file')
  @Permission(['readAny'])
  public async downloadFile(@FromModel({ paramField: 'slug', queryField: 'Slug' }) entry: DbConfig) {
    const options = entry.Type === 'file' ? entry.Meta?.file : undefined;
    if (!options?.fs || !entry.Value) {
      return badRequest(`configuration entry '${entry.Slug}' is not a file entry`);
    }

    const name = String(entry.Value);
    return new FileResponse({ provider: options.fs, path: name, filename: name });
  }

  /**
   * List uploaded files of a file entry
   * Returns the upload history, newest first, with the uploader's id, email and login.
   * @security cookieAuth
   * @param slug Unique configuration entry slug
   * @response 200 Upload history rows
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on configuration resource
   * @response 404 Configuration entry not found
   */
  @Get(':slug/files')
  @Permission(['readAny'])
  public async listFiles(@FromModel({ paramField: 'slug', queryField: 'Slug' }) entry: DbConfig) {
    const rows = await DbConfigFileHistory.where('Slug', entry.Slug).orderByDescending('Id');

    const userIds = [...new Set(rows.map((r) => r.UploadedBy))];
    const users = userIds.length ? await userModel().select().whereIn('Id', userIds) : [];
    const uploaders = new Map<number, IUploaderJson>(users.map((u) => [u.Id, { Id: u.Id, Email: u.Email, Login: u.Login }]));

    return new Ok(rows.map((r) => presentHistoryRow(r, uploaders.get(r.UploadedBy) ?? null)));
  }

  /**
   * Download one uploaded version of a file entry
   * Streams the archived copy, or the original location when the version was never archived.
   * @security cookieAuth
   * @param slug Unique configuration entry slug
   * @param id Upload history row id
   * @response 200 File content
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on configuration resource
   * @response 404 Configuration entry, history row of this entry, or file not found
   */
  @Get(':slug/files/:id')
  @Permission(['readAny'])
  public async downloadFileVersion(@FromModel({ paramField: 'slug', queryField: 'Slug' }) entry: DbConfig, @Param() id: number) {
    const row = await DbConfigFileHistory.where('Slug', entry.Slug).where('Id', id).first();
    if (!row) {
      return new NotFound({ error: { message: `file version ${id} of '${entry.Slug}' not found` } });
    }

    return new FileResponse({ provider: row.Fs, path: row.ArchivedPath ?? row.FileName, filename: row.OriginalName });
  }

  private async storeFile(entry: DbConfig, file: IUploadedFile, user: User) {
    const options = entry.Type === 'file' ? entry.Meta?.file : undefined;
    if (!options?.fs) {
      return badRequest(`configuration entry '${entry.Slug}' is not a file entry`);
    }

    const fsName = options.fs;
    const localPath = file.OriginalFile.filepath;

    const maxSize = options.maxSize ?? CONFIG_FILE_DEFAULT_MAX_SIZE;
    if (file.Size > maxSize) {
      return badRequest(`File is too large: ${file.Size} bytes, the limit is ${maxSize} bytes`);
    }

    const extension = fileExtension(file.Name);
    if (options.extensions?.length && !options.extensions.some((e) => e.toLowerCase() === extension)) {
      return badRequest(`File extension must be one of: ${options.extensions.join(', ')}. Got: ${extension || 'none'}`);
    }

    const mimeType = await this.detectMimeType(localPath);
    if (options.mimeTypes?.length && !options.mimeTypes.includes(mimeType)) {
      return badRequest(`File content type must be one of: ${options.mimeTypes.join(', ')}. Got: ${mimeType || 'unknown'}`);
    }

    if (options.validator) {
      const rejection = await this.runValidator(entry, configFileValidatorName(options.validator), { localPath, originalName: file.Name, size: file.Size, mimeType });
      if (rejection) {
        return rejection;
      }
    }

    const fileName = storedFileName(file.Name, DateTime.utc());

    const schema = this.entryValueSchema(entry);
    if (schema instanceof ServerError) {
      return schema;
    }
    const valueError = this.validateValue(schema, 'Value', fileName);
    if (valueError) {
      return valueError;
    }

    const target = getFs(fsName);
    // same name within the same second - uploading would overwrite the file the entry points at
    if (await target.exists(fileName)) {
      return badRequest(`File ${fileName} was uploaded a moment ago, try again`);
    }

    const hash = await sha256File(localPath);
    await target.upload(localPath, fileName);

    let history: DbConfigFileHistory;
    try {
      history = await this.recordUpload(entry, { Slug: entry.Slug, Fs: fsName, FileName: fileName, OriginalName: file.Name, Size: file.Size, Hash: hash, UploadedBy: user.PrimaryKeyValue as number });
    } catch (err) {
      await target.rm(fileName).catch(() => undefined);
      this.Log.error(`Cannot save uploaded file ${fileName} for '${entry.Slug}': ${(err as Error).message}`);
      return new ServerError({ error: { message: `cannot save uploaded file for '${entry.Slug}'` } });
    }

    await this.archivePrevious(history);

    return new Ok(present(entry));
  }

  private recordUpload(entry: DbConfig, data: Pick<DbConfigFileHistory, 'Slug' | 'Fs' | 'FileName' | 'OriginalName' | 'Size' | 'Hash' | 'UploadedBy'>): Promise<DbConfigFileHistory> {
    return DbConfigFileHistory.transaction(async () => {
      const row = new DbConfigFileHistory({ ...data, ArchivedPath: null });
      await row.insert();

      entry.Value = data.FileName as typeof entry.Value;
      await entry.update();

      return row;
    });
  }

  /**
   * The new file is already current when this runs, so a failed move is only logged and leaves the
   * previous row unarchived instead of failing the upload.
   */
  private async archivePrevious(current: DbConfigFileHistory): Promise<void> {
    const previous = await DbConfigFileHistory.where('Slug', current.Slug).where('Id', '!=', current.Id).whereNull('ArchivedAt').orderByDescending('Id').first();
    if (!previous) {
      return;
    }

    const archivedPath = `archive/${previous.FileName}`;
    try {
      await getFs(previous.Fs).move(previous.FileName, archivedPath);
      previous.ArchivedPath = archivedPath;
      previous.ArchivedAt = DateTime.now();
      await previous.update();
    } catch (err) {
      this.Log.warn(`Cannot archive ${previous.FileName} of '${previous.Slug}': ${(err as Error).message}`);
    }
  }

  /**
   * An unparseable file makes the detector fail; for the upload that is an unknown type, not a server error.
   */
  private async detectMimeType(localPath: string): Promise<string> {
    try {
      return (await this.FileInfo.getInfo(localPath)).MimeType ?? '';
    } catch (err) {
      this.Log.warn(`Cannot detect the content type of an uploaded file: ${(err as Error).message}`);
      return '';
    }
  }

  private async runValidator(entry: DbConfig, name: string, candidate: IConfigFileCandidate): Promise<BadRequestResponse | ServerError | null> {
    const validator = await resolveConfigFileValidator(name);
    if (!validator) {
      this.Log.error(`Configuration file validator '${name}' of '${entry.Slug}' is not registered`);
      return new ServerError({ error: { message: `configuration file validator '${name}' is not registered` } });
    }

    try {
      await validator.validate(candidate, entry);
      return null;
    } catch (err) {
      if (err instanceof ValidationFailed) {
        return badRequest(err.message);
      }
      throw err;
    }
  }

  /**
   * Type + Meta ( Meta already parsed by its @Json converter ), plus the schema registered in
   * @spinajs/validation under the entry's config path, if any. Built per request and not on the
   * request DTO because the entry Type isn't known until the entry is loaded.
   */
  private entryValueSchema(entry: DbConfig): Record<string, unknown> | ServerError {
    let schemaRef: string | undefined;
    try {
      schemaRef = this.Validator.hasSchema(entry.Slug) ? entry.Slug : undefined;
    } catch (err) {
      return this.schemaCompileError(entry.Slug, err as Error);
    }

    return valueSchema(entry.Type, entry.Meta, schemaRef);
  }

  /**
   * `DataValidator.hasSchema` compiles the schema lazily via ajv. A schema that
   * only passed the meta-schema check at startup ( see `@spinajs/validation` )
   * can still fail strict-mode compilation here, e.g. an unregistered `x-*`
   * keyword or format - logged and reported instead of falling back to
   * type-only validation, which would silently skip the constraints the admin
   * registered for this slug.
   */
  private schemaCompileError(slug: string, err: Error): ServerError {
    this.Log.error(`Configuration schema '${slug}' cannot be compiled: ${err.message}`);
    return new ServerError({ error: { message: `configuration schema '${slug}' is invalid` } });
  }

  /**
   * Validates a single value against the entry value schema, returning a 400
   * response on failure or `null` when it passes.
   *
   * The value is wrapped in an object ( `{ [field]: value }` ) so it is always a
   * non-null object for the validator - a bare `null` / scalar would otherwise
   * confuse `tryValidate`'s schema-vs-data overload resolution.
   */
  private validateValue(valueSchema: Record<string, unknown>, field: string, value: unknown): BadRequestResponse | null {
    const [isValid, errors] = this.Validator.tryValidate(
      { type: 'object', properties: { [field]: valueSchema }, required: [field] },
      { [field]: value },
    );

    if (isValid) {
      return null;
    }

    return new BadRequestResponse({ error: { message: formatValidationErrors(field, errors) } });
  }
}
