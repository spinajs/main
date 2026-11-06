import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Logger, Log } from '@spinajs/log-common';
import * as fs from 'fs';
import { createRequire } from 'node:module';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ISchema, ISchemaObject, SchemaSource } from './types.js';

type Glob = typeof import('glob');
const load = createRequire(import.meta.url);
let globModule: Glob | undefined;
// LoadJSONSchema is sync: it takes the module LoadJSSchema imported, and requires it only when called on its own,
// which a single-file bundle cannot do without node_modules
const syncGlob = (): Glob => {
  if (globModule) return globModule;
  try {
    return (globModule = load('glob') as Glob);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw err;
    throw new InvalidOperation('glob is needed to list the JSON schemas when LoadJSONSchema runs before LoadJSSchema, but cannot be loaded: install glob next to the app (a single-file bundle has no node_modules)', err);
  }
};

@Injectable(SchemaSource)
export class FileSystemSource extends SchemaSource {
  @Config('system.dirs.schemas')
  public SchemaDirs: string[];

  @Logger('validation')
  protected Log: Log;

  public async LoadJSSchema(): Promise<ISchema[]> {
    if (!this.SchemaDirs) return [];

    const dirs = this.SchemaDirs.filter((dir) => fs.existsSync(dir));
    if (dirs.length > 0) globModule ??= (await import('glob')).default;

    const promises = dirs
      .flatMap((d: string) => syncGlob().sync(path.join(d, '/**/*.+(js|cjs|mjs)').replace(/\\/g, '/')))
      .map((f) => {
        return import(pathToFileURL(f).href)
          .then((result) => {
            return {
              result: result as { default: unknown },
              file: path.basename(f),
            };
          })
          .catch((err: Error) => {
            this.Log.error({ error: err, file: f }, 'Cannot load schema file ${file}');
            return null;
          });
      });

    const result = await Promise.all(promises);
    return result
      .filter((x): x is { result: { default: unknown }; file: string } => x !== null)
      .filter((x) => {
        if (x.result.default === undefined || x.result.default === null) {
          this.Log.warn({ file: x.file }, 'Schema file ${file} has no default export, skipped');
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
      .flatMap((d: string) => syncGlob().sync(path.join(d, '/**/*.+(json)').replace(/\\/g, '/')))
      .map((f): ISchema | null => {
        try {
          return {
            schema: JSON.parse(fs.readFileSync(f, 'utf-8')) as ISchemaObject,
            file: path.basename(f),
          };
        } catch (err) {
          this.Log.error({ error: err, file: f }, 'Cannot parse schema file ${file}');
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
