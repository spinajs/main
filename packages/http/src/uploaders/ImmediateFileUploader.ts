import { DI, Injectable } from "@spinajs/di";
import { FormFileUploader, IUploadedFile } from "../interfaces.js";
import { fs } from "@spinajs/fs";
import { Log, Logger } from "@spinajs/log-common";
import { IOFail } from "@spinajs/exceptions";

@Injectable()
export class ImmediateFileUploader extends FormFileUploader {

    @Logger('http')
    protected Log: Log;

    constructor(public Filesystem: string) {
        super();

    }
    async upload(file: IUploadedFile<unknown>) {

        // remove temporary files from formidable
        const _rm = async (file: IUploadedFile<unknown>) => {
            try {
                await file.Provider.rm(file.BaseName);
                this.Log.trace(`Deleted temporary incoming file ${file.BaseName}`)
            } catch (err) {
                this.Log.error(err, `Error deleting temporary incoming file ${file.BaseName}`);
            }
        }


        const fs = DI.resolve<fs>("__file_provider__", [this.Filesystem]);

        if (!fs) {
            throw new IOFail(`Filesystem ${this.Filesystem} not exists, pleas check your configuration`);
        }

        try {
            await file.Provider.copy(file.BaseName, file.BaseName, fs);
            this.Log.trace(`Uploaded incoming file ${file.OriginalFile.filepath} to ${file.BaseName} using ${this.Filesystem} filesystem`)
        } catch (err) {
            throw new IOFail(`Error copying incoming file ${file.OriginalFile.filepath} to ${file.BaseName} using ${this.Filesystem} filesystem`, err);
        } finally {
            await _rm(file);
        }

        file.Provider = fs;

        return file;
    }
}