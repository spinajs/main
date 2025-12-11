import { Injectable } from '@spinajs/di';
import { FileUploadMiddleware, IUploadedFile } from '../../src/interfaces.js';

@Injectable()
export class TestTransformer extends FileUploadMiddleware {
  public async beforeUpload(file: IUploadedFile): Promise<IUploadedFile> {
    return file;
  }
}
