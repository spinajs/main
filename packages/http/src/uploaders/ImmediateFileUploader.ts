import { Injectable, NewInstance } from '@spinajs/di';
import { FormFileUploader, IUploadedFile } from '../interfaces.js';
import { fs } from '@spinajs/fs';
import { Log, Logger } from '@spinajs/log-common';
import { IOFail } from '@spinajs/exceptions';

@Injectable()
@NewInstance()
export class ImmediateFileUploader extends FormFileUploader {
  @Logger('http')
  protected Log: Log;

  constructor(public Options: { deleteSource?: boolean, sourceFs?: fs }) {
    super();
  }
  async upload(file: IUploadedFile<unknown>): Promise<IUploadedFile<unknown>> {

    if(!file.Provider){
        throw new Error(`File provider is not available for file ${file.BaseName}. ImmediateFileUploader requires file provider to be able to upload file. Make sure you are using compatible file provider that supports required operations`);
    }

    // if its the same - do nothing
    if (this.Options.sourceFs?.Name === file.Provider!.Name) {
      return file;
    }

    try {
      await this.Options.sourceFs!.copy(file.BaseName, file.BaseName, file.Provider ?? undefined);
      this.Log.trace({ source: file.OriginalFile.filepath, target: file.BaseName, fs: file.Provider!.Name }, 'Uploaded incoming file ${source} to ${target} using ${fs} filesystem');

      if (this.Options.deleteSource) {
        await this.Options.sourceFs!.rm(file.BaseName);
        this.Log.trace(
          { source: file.OriginalFile.filepath, sourceFs: this.Options.sourceFs!.Name, fs: file.Provider!.Name },
          'Deleted source incoming file ${source} from ${sourceFs} filesystem after upload to ${fs} filesystem',
        );
      }

    } catch (err) {
      throw new IOFail(`Error copying incoming file ${file.OriginalFile.filepath} to ${file.BaseName} using ${file.Provider!.Name} filesystem`, err);
    }

    return file;
  }
}
