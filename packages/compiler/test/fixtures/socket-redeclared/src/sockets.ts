import { BaseSocketController, Command, SocketAccess, SocketController } from '@spinajs/http-socket';

export class Doc {
  public id!: string;
  public title!: string;
}

@SocketAccess('doc:read', { fields: 'filter' })
export abstract class AbstractBase extends BaseSocketController {
  @Command('a') public async a(): Promise<Doc> { return new Doc(); }
  @Command('g') @SocketAccess('doc:update', { fields: 'filter' }) public async g(): Promise<Doc> { return new Doc(); }
  @Command('p') @SocketAccess('doc:update') public async p(): Promise<Doc> { return new Doc(); }
}

@SocketController('i1')
export class I1Socket extends AbstractBase {}

@SocketController('i2')
export class I2Socket extends AbstractBase {
  @Command('g') public override async g(): Promise<Doc> { return new Doc(); }
  @Command('p') public override async p(): Promise<Doc> { return new Doc(); }
}

@SocketController('i3')
@SocketAccess('doc:read')
export class I3Socket extends AbstractBase {
  @Command('g') public override async g(): Promise<Doc> { return new Doc(); }
}

@SocketController('i4')
export class I4Socket extends AbstractBase {
  @Command('g') @SocketAccess('doc:update') public override async g(): Promise<Doc> { return new Doc(); }
  @Command('p') @SocketAccess('doc:update', { fields: 'filter-rows' }) public override async p(): Promise<Doc> { return new Doc(); }
}

@SocketController('i5')
export class I5Socket extends I1Socket {
  @Command('own') public async own(): Promise<Doc> { return new Doc(); }
}
