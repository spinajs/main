import { Injectable } from '@spinajs/di';
import { FileTransformer, IUploadedFile } from '../../src/interfaces.js';

@Injectable()
export class TestTransformer extends FileTransformer {
  public async transform(file: IUploadedFile): Promise<IUploadedFile> {
    return file;
  }
}
