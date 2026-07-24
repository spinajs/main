import { Injectable } from '@spinajs/di';
import { FileUploadMiddleware, IUploadedFile } from '../../src/interfaces.js';

// NOTE: must NOT be called `TestTransformer` - test/transformers/TestTransformer.ts
// already uses that name for a DataTransformer, and the DI cache is keyed by
// class NAME, so the two collide and whichever resolves first wins.
@Injectable()
export class TestFileTransformer extends FileUploadMiddleware {
  public async beforeUpload(file: IUploadedFile): Promise<IUploadedFile> {
    return file;
  }
}
