import { BasePolicy } from '@spinajs/http';
import { BaseSocketController, Command, OnEvent, Payload, SocketAccess, SocketController } from '@spinajs/http-socket';

export class OwnerPolicy extends BasePolicy { public isEnabled(): boolean { return true; } public async execute(): Promise<void> {} }
export class Share { public id: string }

@SocketController('share')
@SocketAccess('doc:read', { also: [OwnerPolicy] })
export class ShareSocket extends BaseSocketController {
  @Command('blob')
  @SocketAccess('doc:share', { also: [OwnerPolicy], unfilteredInput: 'the payload is a signed blob' })
  public async blob(@Payload() payload: Share): Promise<void> { void payload; }

  @OnEvent('seen')
  @SocketAccess('doc:read')
  public async seen(@Payload() payload: Share): Promise<void> { void payload; }
}
