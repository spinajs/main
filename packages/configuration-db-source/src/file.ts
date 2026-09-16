import { DI } from '@spinajs/di';
import type { Class, IMappableService } from '@spinajs/di';
// type-only: DbConfig -> types -> file would otherwise form a runtime import cycle
import type { DbConfig } from './models/DbConfig.js';
import type { ConfigurationEntryType, IConfigurationEntryMeta } from './types.js';

export const CONFIG_FILE_DEFAULT_MAX_SIZE = 10 * 1024 * 1024;

export interface IConfigurationFileOptions {
  /** Name of the @spinajs/fs provider the file is stored in. */
  fs: string;
  /** Allowed extensions, lowercase, without the dot, e.g. ['xlsx']. */
  extensions?: string[];
  /** Allowed mime types, compared with the type detected from the file content. */
  mimeTypes?: string[];
  /** Max size in bytes, CONFIG_FILE_DEFAULT_MAX_SIZE when not set. */
  maxSize?: number;
  /** A class registered as ConfigFileValidator, or its name. Always stored as the name. */
  validator?: string | Class<ConfigFileValidator>;
}

export interface IConfigFileCandidate {
  /** Local path of the uploaded temp file. */
  localPath: string;
  /** Name sent by the client. */
  originalName: string;
  size: number;
  /** Mime type detected from content. */
  mimeType: string;
}

/**
 * Register implementations with `@Injectable(ConfigFileValidator)` and reference them from
 * `meta.file.validator`. Throw `ValidationFailed` to reject a file - its message is shown to the admin.
 */
export abstract class ConfigFileValidator {
  public abstract validate(file: IConfigFileCandidate, entry: DbConfig): Promise<void>;
}

export function configFileValidatorName(validator: string | Class<ConfigFileValidator>): string {
  return typeof validator === 'string' ? validator : validator.name;
}

/**
 * Runs before an exposed option's `Meta` is written: a class cannot be stored in JSON, and a file
 * entry without a provider must fail at startup rather than at the first upload.
 */
export function normalizeFileEntryOptions(path: string, exposeOptions?: { type: ConfigurationEntryType; meta?: IConfigurationEntryMeta }): void {
  if (!exposeOptions) {
    return;
  }

  const file = exposeOptions.meta?.file;

  if (exposeOptions.type === 'file' && !file?.fs) {
    throw new Error(`Configuration entry '${path}' has type 'file' but no exposeOptions.meta.file.fs`);
  }

  if (file?.validator) {
    file.validator = configFileValidatorName(file.validator);
  }
}

/**
 * Same naming rule as `@AutoinjectService`: an instance `ServiceName` wins over the class name.
 */
export function resolveConfigFileValidator(name: string): ConfigFileValidator | undefined {
  const types = DI.getRegisteredTypes(ConfigFileValidator) ?? [];

  for (const type of types) {
    const validator = DI.resolve<ConfigFileValidator>(type);
    if (((validator as Partial<IMappableService>).ServiceName ?? type.name) === name) {
      return validator;
    }
  }

  return undefined;
}
