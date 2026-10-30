import { BaseController, BasePath, File, Files, Post } from '@spinajs/http';
import type { IUploadedFile } from '@spinajs/http';

@BasePath('files')
export class FilesController extends BaseController {
  @Post('one')
  public async one(@File() file: IUploadedFile): Promise<void> { void file; }

  @Post('many')
  public async many(@Files() files: IUploadedFile[]): Promise<void> { void files; }
}
