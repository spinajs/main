import { SocketController, Command, OnEvent, Payload, SocketPolicy, BaseSocketController, SocketAccess } from '@spinajs/http-socket';
import { AdminPolicy } from './controller.js';

export class OpenDoc { public id: string }
export class DocOpened { public id: string; public title: string }
export class Ping { public at: number }

@SocketController('docs')
@SocketPolicy(AdminPolicy)
export class DocsSocket extends BaseSocketController {
  @Command('open', { idempotent: true, ordered: 'client', timeoutMs: 5000 })
  @SocketAccess('doc:read')
  public async open(@Payload() payload: OpenDoc): Promise<DocOpened> { return { id: payload.id, title: '' }; }

  @Command()
  public async close(@Payload() payload: OpenDoc): Promise<void> { void payload; }

  @OnEvent('ping')
  public async ping(@Payload() payload: Ping): Promise<void> { void payload; }
}
