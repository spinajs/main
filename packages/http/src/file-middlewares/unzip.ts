import { Injectable, Singleton } from "@spinajs/di";
import { FileUploadMiddleware, IUploadedFile } from "../interfaces.js";
import { Log, Logger } from "@spinajs/log-common";
import { basename } from "path";

@Injectable()
@Singleton()
export class UnzipFileTransformer extends FileUploadMiddleware {
    @Logger('http')
    protected Log!: Log;

    public async beforeUpload(file: IUploadedFile<any>): Promise<any> {

        const originalName = file.BaseName;
        const originalSize = file.Size;

        if(!file.Provider){
            throw new Error(`File provider is not available for file ${file.BaseName}. Unzip middleware requires file provider to be able to unzip file. Make sure you are using compatible file provider that supports unzip operation`);
        }


        try {
            this.Log.timeStart(`[ZIP] ${originalName}`)
            const result = await file.Provider!.unzip(file.BaseName, undefined, file.Provider!);
            const stat = await file.Provider!.stat(result);
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
            await file.Provider!.rm(originalName);
        }

    }
}