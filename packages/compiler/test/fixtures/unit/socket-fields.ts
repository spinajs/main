declare function SocketController(prefix?: string): ClassDecorator;
declare function Command(name?: string): MethodDecorator;
declare function SocketAccess(permission: string, options?: { fields?: string }): MethodDecorator;
declare function fieldsMode(): string;

const MODE = fieldsMode();
const FILTER = 'filter';
const FILTER_OPTIONS = { fields: 'filter' };
let OPTIONS = { fields: 'none' };
OPTIONS = { fields: 'filter' };

export class Doc {
  public title!: string;
}

@SocketController('docs')
export class FieldsSocket {
  @Command() @SocketAccess('doc:read', { fields: MODE }) public async unreadable(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:read', OPTIONS) public async letOptions(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:read', { fields: 'filter' }) public async filter(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:read', { fields: 'filter-rows' }) public async filterRows(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:read', { fields: FILTER }) public async constant(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:read', FILTER_OPTIONS) public async constOptions(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:read', { fields: 'none' }) public async none(): Promise<Doc> { return new Doc(); }
  @Command() @SocketAccess('doc:read') public async plain(): Promise<Doc> { return new Doc(); }
}
