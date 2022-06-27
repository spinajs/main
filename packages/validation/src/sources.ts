import { Config } from '@spinajs/configuration/lib';
import { Injectable } from '@spinajs/di';
import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';
import { ISchema, SchemaSource, ISchemaObject } from './types';

@Injectable(SchemaSource)
export class FileSystemSource extends SchemaSource {
  @Config('system.dirs.schemas')
  public SchemaDirs: string[];

  public Load(): ISchema[] {
    if (!this.SchemaDirs) return [];

    return this.SchemaDirs.filter((dir) => fs.existsSync(dir))
      .flatMap((d: string) => glob.sync(path.join(d, '/**/*.+(json|js)')))
      .map((f) => {
        return {
          schema: require(f) as ISchemaObject,
          file: path.basename(f),
        };
      });
  }
}
