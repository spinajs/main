import { SocketController } from '@spinajs/http-socket';
import type { FileDto } from '../../inherited-lib/lib/crud.js';
import { FeedSocket } from '../../inherited-lib/lib/sockets.js';

@SocketController('files')
export class FilesFeed extends FeedSocket<FileDto> {}
