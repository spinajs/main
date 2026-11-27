import { SocketAccess, SocketController } from '@spinajs/http-socket';
import type { FileDto } from '../../inherited-lib/lib/crud.js';
import { FeedSocket, GuardedFeedSocket } from '../../inherited-lib/lib/sockets.js';

@SocketController('files')
export class FilesFeed extends FeedSocket<FileDto> {}

@SocketController('guarded')
export class GuardedFeed extends GuardedFeedSocket<FileDto> {}

@SocketController('guarded-open')
@SocketAccess('feed:share')
export class OpenGuardedFeed extends GuardedFeedSocket<FileDto> {}
