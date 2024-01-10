import { Injectable } from "@spinajs/di";
import { FileTransformer, IUploadedFile } from "../interfaces.js";
import { Log, Logger } from "@spinajs/log-common";
import Path from 'path';

@Injectable()
export class ZipFileTransformer extends FileTransformer {
    @Logger('http')
    protected Log: Log;

    public async transform(file: IUploadedFile<any>): Promise<IUploadedFile<any>> {
        const originalName = file.BaseName;
        const originalSize = file.Size;

        try {
            this.Log.timeStart(`[ZIP] ${originalName}`)

            const result = await file.Provider.zip(originalName, file.Provider);
            const stat = await file.Provider.stat(result.asFilePath());
            
            const duration = this.Log.timeEnd(`[ZIP] ${originalName}`);
            this.Log.trace(`[ZIP] Transformed ${originalName} to ${result.asFilePath()}, duration: ${duration}ms`);

            return {
                ...file,
                BaseName: result.asFilePath(),
                Size: stat.Size,
                Type: "application/zip",
                Name: Path.parse(file.Name).name + ".zip",
                Data: {
                    OriginalName: originalName,
                    OriginalSize: originalSize
                }
            }
        } catch (err) {
            throw err;
        }
        finally {
            await file.Provider.rm(originalName);
        }


    }

}