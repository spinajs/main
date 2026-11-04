import { BasePath } from '@spinajs/http';
import { StoreController, Undocumented, type FileDto } from '../../inherited-lib/lib/crud.js';

@BasePath('files')
export class FilesController extends StoreController<FileDto> {}

export class LooseController extends Undocumented {}
