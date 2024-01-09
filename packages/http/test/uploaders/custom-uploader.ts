import { Injectable } from '@spinajs/di';
import { FormFileUploader, IUploadedFile } from '../../src/interfaces.js';

@Injectable()
export class CustomFileUploader extends FormFileUploader {
  public async upload(file: IUploadedFile): Promise<IUploadedFile> {
    return file;
  }
}
