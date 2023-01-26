import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import * as fs from 'fs';
import glob from 'glob';
import * as path from 'path';
import { ISchema, SchemaSource } from './types.js';

@Injectable(SchemaSource)
export class FileSystemSource extends SchemaSource {
  @Config('system.dirs.schemas')
  public SchemaDirs: string[];

  public async LoadJSSchema() {
    if (!this.SchemaDirs) return [];

    const promises = this.SchemaDirs.filter((dir) => fs.existsSync(dir))
      .flatMap((d: string) => glob.sync(path.join(d, '/**/*.+(js|cjs)').replace(/\\/g, '/')))
      .map((f) => {
        return import(`file://${f}`).then((result) => {
          return {
            result,
            file: path.basename(f),
          };
        });
      });

    const result = await Promise.all(promises);
    return result.map((x) => {
      return {
        schema: x.result.default,
        file: x.file,
      };
    });
  }

  public LoadJSONSchema() {
    if (!this.SchemaDirs) return [];

    return this.SchemaDirs.filter((dir) => fs.existsSync(dir))
      .flatMap((d: string) => glob.sync(path.join(d, '/**/*.+(json)').replace(/\\/g, '/')))
      .map((f) => {
        return {
          schema: JSON.parse(fs.readFileSync(f, 'utf-8')),
          file: path.basename(f),
        };
      });
  }

  public async Load(): Promise<ISchema[]> {
    const sJS = await this.LoadJSSchema();
    const sJSON = this.LoadJSONSchema();

    return sJS.concat(sJSON);
  }
}
