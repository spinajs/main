import { Injectable } from '@spinajs/di';
import { FormFileUploader, IUploadedFile } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log-common';
import { LazyUploadJob } from './job.js';

@Injectable()
export class HttpLazyFileUploader extends FormFileUploader {
  @Logger('http')
  protected Log: Log;

  constructor(public Options: { fs: string }) {
    super();
  }

  public async upload(file: IUploadedFile) : Promise<IUploadedFile<any>> {
    await LazyUploadJob.emit({
      ToFilesystem: this.Options.fs,
      Path: file.BaseName,
      SourceFilesystem: file.Provider.Name,
    });

    return {
      ...file,
      Provider: null,
    };
  }
}
