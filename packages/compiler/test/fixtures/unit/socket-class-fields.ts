declare function SocketController(prefix?: string): ClassDecorator;
declare function Command(name?: string): MethodDecorator;
declare function SocketAccess(permission: string, options?: { fields?: string }): ClassDecorator & MethodDecorator;
declare function classFieldsMode(): string;

const MODE = classFieldsMode();

export class Doc {
  public title!: string;
}

@SocketController('bare')
export class BareSocket {
  @Command() public async plain(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:update') public async own(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:update', { fields: 'filter-rows' }) public async rows(): Promise<Doc> { return new Doc(); }
}

@SocketController('filtered')
@SocketAccess('doc:read', { fields: 'filter' })
export class FilteredSocket {
  @Command() public async plain(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:update') public async own(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:update', { fields: 'filter-rows' }) public async rows(): Promise<Doc> { return new Doc(); }
}

@SocketController('unread')
@SocketAccess('doc:read', { fields: MODE })
export class UnreadSocket {
  @Command() public async plain(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:update') public async own(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:update', { fields: 'filter-rows' }) public async rows(): Promise<Doc> { return new Doc(); }
}

@SocketController('none')
@SocketAccess('doc:read', { fields: 'none' })
export class NoneSocket {
  @Command() public async plain(): Promise<Doc> { return new Doc(); }
}

@SocketController('sub')
export class SubSocket extends FilteredSocket {
  @Command() public async extra(): Promise<Doc> { return new Doc(); }
}

@SocketController('sub-open')
@SocketAccess('doc:read')
export class SubOpenSocket extends FilteredSocket {}

@SocketController('sub-rows')
@SocketAccess('doc:read', { fields: 'filter-rows' })
export class SubRowsSocket extends FilteredSocket {}

@SocketController('leaf')
export class LeafSocket extends SubSocket {}
