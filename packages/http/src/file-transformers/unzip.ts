import { Injectable } from "@spinajs/di";
import { FileTransformer, IUploadedFile } from "../interfaces.js";
import { Log, Logger } from "@spinajs/log-common";
import { basename } from "path";

@Injectable()
export class UnzipFileTransformer extends FileTransformer {
    @Logger('http')
    protected Log: Log;

    public async transform(file: IUploadedFile<any>): Promise<any> {

        const originalName = file.BaseName;
        const originalSize = file.Size;

        try {
            this.Log.timeStart(`[ZIP] ${originalName}`)
            const result = await file.Provider.unzip(file.BaseName, null, file.Provider);
            const stat = await file.Provider.stat(result);
            const duration = this.Log.timeEnd(`[ZIP] ${originalName}`);
            this.Log.trace(`[ZIP] Unpacking ${originalName} to ${result}, duration: ${duration}ms`);
            
            return {
                ...file,
                BaseName: basename(result),
                Size: stat.Size,
                Type: "unknown",
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