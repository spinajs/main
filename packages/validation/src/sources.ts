import { Config } from "@spinajs/configuration/lib";
import { Injectable } from "@spinajs/di";
import { Log } from "@spinajs/log/lib/log";
import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';

interface ISchema {
    schema: any;
    file?: string;
}

export abstract class SchemaSource {
    public abstract Load(): ISchema[];
}

@Injectable(SchemaSource)
export class FileSystemSource extends SchemaSource {

    @Config("system.dirs.schemas")
    public SchemaDirs: string[];

    public Load(): ISchema[] {
        return this.SchemaDirs.filter(dir => fs.existsSync(dir))
            .flatMap((d: string) => glob.sync(path.join(d, "/**/*.+(json|js)")))
            .map(f => {

                Log.trace(`Found schema at: ${f}`, "validation");

                return {
                    schema: require(f),
                    file: path.basename(f)
                };
            })
    }

}