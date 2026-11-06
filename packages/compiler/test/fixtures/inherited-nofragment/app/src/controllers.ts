import { BasePath } from '@spinajs/http';
import { StoreController, type FileDto } from '../../dep/lib/crud.js';

@BasePath('files')
export class FilesController extends StoreController<FileDto> {}
