import { DI, Injectable, NewInstance } from '@spinajs/di';
import { FormFileUploader, IUploadedFile } from '../interfaces.js';
import { fs } from '@spinajs/fs';
import { Log, Logger } from '@spinajs/log-common';
import { IOFail } from '@spinajs/exceptions';

@Injectable()
@NewInstance()
export class ImmediateFileUploader extends FormFileUploader {
  @Logger('http')
  protected Log: Log;

  constructor(public Options: { fs: string }) {
    super();
  }
  async upload(file: IUploadedFile<unknown>) {
    const fs = DI.resolve<fs>('__file_provider__', [this.Options.fs]);

    if (!fs) {
      throw new IOFail(`Filesystem ${this.Options.fs} not exists, pleas check your configuration`);
    }

    // if its the same - do nothing
    if (fs.Name === file.Provider.Name) {
      return;
    }

    try {
      await file.Provider.copy(file.BaseName, file.BaseName, fs);
      this.Log.trace(`Uploaded incoming file ${file.OriginalFile.filepath} to ${file.BaseName} using ${this.Options.fs} filesystem`);
    } catch (err) {
      throw new IOFail(`Error copying incoming file ${file.OriginalFile.filepath} to ${file.BaseName} using ${this.Options.fs} filesystem`, err);
    }

    file.Provider = fs;

    return file;
  }
}
