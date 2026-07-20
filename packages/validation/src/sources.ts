import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log-common';
import * as fs from 'fs';
import glob from 'glob';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ISchema, ISchemaObject, SchemaSource } from './types.js';

@Injectable(SchemaSource)
export class FileSystemSource extends SchemaSource {
  @Config('system.dirs.schemas')
  public SchemaDirs: string[];

  @Logger('validation')
  protected Log: Log;

  public async LoadJSSchema(): Promise<ISchema[]> {
    if (!this.SchemaDirs) return [];

    const promises = this.SchemaDirs.filter((dir) => fs.existsSync(dir))
      .flatMap((d: string) => glob.sync(path.join(d, '/**/*.+(js|cjs|mjs)').replace(/\\/g, '/')))
      .map((f) => {
        return import(pathToFileURL(f).href)
          .then((result) => {
            return {
              result: result as { default: unknown },
              file: path.basename(f),
            };
          })
          .catch((err: Error) => {
            this.Log.error(`Cannot load schema file ${f}, reason: ${err.message}`, 'validator');
            return null;
          });
      });

    const result = await Promise.all(promises);
    return result
      .filter((x): x is { result: { default: unknown }; file: string } => x !== null)
      .filter((x) => {
        if (x.result.default === undefined || x.result.default === null) {
          this.Log.warn(`Schema file ${x.file} has no default export, skipped`, 'validator');
          return false;
        }
        return true;
      })
      .map((x) => {
        return {
          schema: x.result.default as ISchemaObject,
          file: x.file,
        };
      });
  }

  public LoadJSONSchema(): ISchema[] {
    if (!this.SchemaDirs) return [];

    return this.SchemaDirs.filter((dir) => fs.existsSync(dir))
      .flatMap((d: string) => glob.sync(path.join(d, '/**/*.+(json)').replace(/\\/g, '/')))
      .map((f): ISchema | null => {
        try {
          return {
            schema: JSON.parse(fs.readFileSync(f, 'utf-8')) as ISchemaObject,
            file: path.basename(f),
          };
        } catch (err) {
          this.Log.error(`Cannot parse schema file ${f}, reason: ${(err as Error).message}`, 'validator');
          return null;
        }
      })
      .filter((s): s is ISchema => s !== null);
  }

  public async Load(): Promise<ISchema[]> {
    const sJS = await this.LoadJSSchema();
    const sJSON = this.LoadJSONSchema();

    return sJS.concat(sJSON);
  }
}
