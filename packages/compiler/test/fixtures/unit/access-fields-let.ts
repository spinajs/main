declare function Get(p?: string): MethodDecorator;
declare function Access(permission: string, options?: object): ClassDecorator & MethodDecorator;
declare class BaseController {}

let fields = 'none';
let OPTIONS = { fields: 'none' };
fields = 'filter';
OPTIONS = { fields: 'filter' };

export class LetFieldsController extends BaseController {
  @Get('shorthandLet') @Access('doc:read', { fields }) public shorthandLet(): void {}
  @Get('letOptions') @Access('doc:read', OPTIONS) public letOptions(): void {}
}
