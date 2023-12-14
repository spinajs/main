import { DI, Injectable } from "@spinajs/di";
import { FormFileUploader } from "../interfaces.js";
import { fs } from "@spinajs/fs";
import formidable from "formidable";
import { rm } from "fs/promises";
import { basename } from "path";
import { Log, Logger } from "@spinajs/log-common";
import { IOFail } from "@spinajs/exceptions";

@Injectable(FormFileUploader)
export class ImmediateFileUploader extends FormFileUploader {

    @Logger('http')
    protected Log: Log;

    constructor(public Filesystem: string) {
        super();

    }
    async upload(file: formidable.File, dst: string) {

        // remove temporary files from formidable
        const _rm = async (file: formidable.File) => {
            try {
                await rm(file.filepath);
                this.Log.trace(`Deleted temporary incoming file ${file.filepath}`)
            } catch (err) {
                this.Log.error(err, `Error deleting temporary incoming file ${file.filepath}`);
            }
        }


        const fs = DI.resolve<fs>("__file_provider__", [this.Filesystem]);

        if (!fs) {
            throw new IOFail(`Filesystem ${this.Filesystem} not exists, pleas check your configuration`);
        }

        try {
            await fs.upload(file.filepath, dst);
            this.Log.trace(`Uploaded incoming file ${file.filepath} to ${dst} using ${this.Filesystem} filesystem`)
        } catch (err) {
            this.Log.error(err, `Error copying incoming file ${file.filepath} to ${dst} using ${this.Filesystem} filesystem`);
        } finally {
            await _rm(file);
        }

        return {
            Size: file.size,
            BaseName: basename(file.filepath),
            Provider: fs,
            Name: file.originalFilename,
            Type: file.mimetype,
            LastModifiedDate: file.mtime,
            Hash: file.hash,

        }
    }
}