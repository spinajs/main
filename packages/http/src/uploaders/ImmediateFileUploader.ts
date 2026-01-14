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
  async upload(file: IUploadedFile<unknown>) {

    // if its the same - do nothing
    if (this.Options.sourceFs?.Name === file.Provider.Name) {
      return;
    }

    try {
      await this.Options.sourceFs.copy(file.BaseName, file.BaseName, file.Provider);
      this.Log.trace(`Uploaded incoming file ${file.OriginalFile.filepath} to ${file.BaseName} using ${file.Provider.Name} filesystem`);

      if (this.Options.deleteSource) {
        await this.Options.sourceFs.rm(file.BaseName);
        this.Log.trace(`Deleted source incoming file ${file.OriginalFile.filepath} from ${this.Options.sourceFs.Name} filesystem after upload to ${file.Provider.Name} filesystem`);
      }

    } catch (err) {
      throw new IOFail(`Error copying incoming file ${file.OriginalFile.filepath} to ${file.BaseName} using ${file.Provider.Name} filesystem`, err);
    }
 
    return file;
  }
}
