declare function Get(p?: string): MethodDecorator;
declare function Access(permission: string, options?: object): ClassDecorator & MethodDecorator;
declare class BaseController {}

const fields = 'none';

export class ShorthandNoneController extends BaseController {
  @Get('shorthandNone') @Access('doc:read', { fields }) public shorthandNone(): void {}
}
