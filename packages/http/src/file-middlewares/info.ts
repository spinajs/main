import { Autoinject, Injectable, Singleton } from "@spinajs/di";
import { FileUploadMiddleware, IUploadedFile, IUploadOptions } from "../interfaces.js";
import { Log, Logger } from "@spinajs/log-common";
import { FileInfoService } from "@spinajs/fs";


/**
 * Middleware that retrieves file info after upload
 */
@Injectable()
@Singleton()
export class FileInfoMiddleware extends FileUploadMiddleware {
    @Logger('http')
    protected Log: Log;

    @Autoinject()
    protected FileInfo : FileInfoService;

    public async beforeUpload(file: IUploadedFile<any>, paramOptions: IUploadOptions): Promise<any> {

        /**
         * Only if option is set
         */
        if (paramOptions.fileInfo) {

            if(!this.FileInfo){
                this.Log.warn(`FileInfo service not available, cannot retrieve file info for uploaded file ${file.Name}.`);
                return file;
            }

            return {
                ...file,
                Info: await this.FileInfo.getInfo(file.OriginalFile.filepath)
            }
        }

        return file;

    }
}