declare function Get(p?: string): MethodDecorator;
declare function Access(permission: string, options?: object): ClassDecorator & MethodDecorator;
declare function fieldsMode(): 'filter' | 'filter-rows' | 'none';
declare function keyOf(): string;
declare function optionsOf(): object;
declare const SHARED: object;
declare class BaseController {}

const MODE = fieldsMode();
const LITERAL = 'filter-rows';
const fields = 'filter';
const KEY = keyOf();
const UNREAD_OPTIONS = { fields: MODE };
const FILTER_OPTIONS = { fields: 'filter' };

export class FieldsController extends BaseController {
  @Get('shorthand') @Access('doc:read', { fields }) public shorthand(): void {}
  @Get('unreadable') @Access('doc:read', { fields: MODE }) public unreadable(): void {}
  @Get('constant') @Access('doc:read', { fields: LITERAL }) public constant(): void {}
  @Get('constOptions') @Access('doc:read', FILTER_OPTIONS) public constOptions(): void {}
  @Get('satisfiesOptions') @Access('doc:read', { fields: 'filter' } satisfies object) public satisfiesOptions(): void {}
  @Get('none') @Access('doc:read', { fields: 'none' }) public none(): void {}
  @Get('plain') @Access('doc:read') public plain(): void {}
  @Get('variable') @Access('doc:read', UNREAD_OPTIONS) public variable(): void {}
  @Get('spread') @Access('doc:read', { ...UNREAD_OPTIONS }) public spread(): void {}
  @Get('spreadAfterNone') @Access('doc:read', { fields: 'none', ...SHARED }) public spreadAfterNone(): void {}
  @Get('computedKey') @Access('doc:read', { [KEY]: 'none' }) public computedKey(): void {}
  @Get('noneAfterSpread') @Access('doc:read', { ...SHARED, fields: 'none' }) public noneAfterSpread(): void {}
  @Get('optionsCall') @Access('doc:read', optionsOf()) public optionsCall(): void {}
  @Get('resourceNone') @Access('doc:read', { resource: (r: unknown) => r, fields: 'none' }) public resourceNone(): void {}
}
