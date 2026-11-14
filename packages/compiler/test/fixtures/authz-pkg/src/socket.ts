import { BasePolicy } from '@spinajs/http';
import { BaseSocketController, Command, OnEvent, Payload, SocketAccess, SocketController, SocketPolicy } from '@spinajs/http-socket';

export class AdminPolicy extends BasePolicy { public isEnabled(): boolean { return true; } public async execute(): Promise<void> {} }
export class Edit { public id: string }

@SocketController('docs')
@SocketPolicy(AdminPolicy)
@SocketAccess('doc:read')
export class DocsSocket extends BaseSocketController {
  @Command('edit')
  @SocketAccess('doc:update')
  public async edit(@Payload() payload: Edit): Promise<void> { void payload; }

  @Command('ping')
  public async ping(): Promise<void> {}

  @OnEvent('seen')
  @SocketAccess('doc:read')
  public async seen(@Payload() payload: Edit): Promise<void> { void payload; }
}

@SocketController()
export class OpenSocket extends BaseSocketController {
  @OnEvent('hello')
  public async hello(): Promise<void> {}
}
