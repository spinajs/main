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

const SIGNED_BLOB = 'the payload is a signed blob';
const reasonOf = (): string => 'decided when the module loads';

@SocketController('reason')
export class ReasonSocket extends BaseSocketController {
  @Command('constant')
  @SocketAccess('doc:share', { unfilteredInput: SIGNED_BLOB })
  public async constant(@Payload() payload: Share): Promise<void> { void payload; }

  @Command('asConst')
  @SocketAccess('doc:share', { unfilteredInput: 'checked by the issuer' as const })
  public async asConst(@Payload() payload: Share): Promise<void> { void payload; }

  @Command('template')
  @SocketAccess('doc:share', { unfilteredInput: `checked by the issuer` })
  public async template(@Payload() payload: Share): Promise<void> { void payload; }

  @Command('computed')
  @SocketAccess('doc:share', { unfilteredInput: reasonOf() })
  public async computed(@Payload() payload: Share): Promise<void> { void payload; }
}
