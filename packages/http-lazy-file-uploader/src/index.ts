import { Injectable } from '@spinajs/di';
import { FormFileUploader, IUploadedFile } from "@spinajs/http";
import { Log, Logger } from '@spinajs/log-common';
import { QueueClient } from '@spinajs/queue';
import { LazyUploadJob } from './job.js';


@Injectable(FormFileUploader)
export class HttpLazyFileUploader extends FormFileUploader {

    @Logger('http')
    protected Log: Log;


    constructor(public Filesystem: string) {
        super();

    }

    public async upload(file: IUploadedFile) {

        await LazyUploadJob.emit({
            ToFilesystem: this.Filesystem,
            Path: file.BaseName,
            SourceFilesystem: file.Provider.Name
        });

        return {
            ...file,
            Provider: null
        };
    }
}