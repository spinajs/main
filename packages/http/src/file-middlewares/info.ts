import { Injectable, Singleton } from "@spinajs/di";
import { FileUploadMiddleware, IUploadedFile, IUploadOptions } from "../interfaces.js";
import { Log, Logger } from "@spinajs/log-common";


/**
 * Middleware that retrieves file info after upload
 */
@Injectable()
@Singleton()
export class FileInfoMiddleware extends FileUploadMiddleware {
    @Logger('http')
    protected Log: Log;

    public async transform(file: IUploadedFile<any>, paramOptions: IUploadOptions): Promise<any> {

        /**
         * Only if option is set
         */
        if (!paramOptions.fileInfo) {

            if(!file.Provider){
                this.Log.warn(`File provider not set on uploaded file ${file.Name}, cannot retrieve file info.`);
                return file;
            }

            return {
                ...file,
                Info: await file.Provider.metadata(file.BaseName)
            };
        }

        return file;

    }
}