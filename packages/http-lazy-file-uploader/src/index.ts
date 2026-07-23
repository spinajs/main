import { Injectable } from '@spinajs/di';
import { FormFileUploader, IUploadedFile } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log-common';
import { LazyUploadJob } from './job.js';

@Injectable()
export class HttpLazyFileUploader extends FormFileUploader {
  @Logger('http')
  protected Log!: Log;

  constructor(public Options: { fs: string; deleteAfterUpload?: boolean }) {
    super();
  }

  public async upload(file: IUploadedFile) : Promise<IUploadedFile<any>> {

    if(!file.Provider){
        throw new Error(`File provider is not available for file ${file.BaseName}. HttpLazyFileUploader requires file provider to be able to upload file. Make sure you are using compatible file provider that supports required operations`);
    }

    await LazyUploadJob.emit({
      ToFilesystem: this.Options.fs,
      Path: file.BaseName,
      SourceFilesystem: file.Provider!.Name,
      // Clean up the intermediate (temp) source once the lazy copy completes,
      // otherwise uploaded files pile up in the source fs forever. Opt out with
      // deleteAfterUpload: false when the source must be retained.
      DeleteAfterUpload: this.Options.deleteAfterUpload ?? true,
    });

    return {
      ...file,
      Provider: null,
    };
  }
}
