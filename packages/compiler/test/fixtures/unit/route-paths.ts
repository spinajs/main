declare function BasePath(p: string | { config: string; default: string }): ClassDecorator;
declare function Get(p?: string): MethodDecorator;
declare function Post(p?: string): MethodDecorator;
declare class BaseController {}

@BasePath('users')
export class UsersPathController extends BaseController {
  @Get() public list(): void {}
  @Get('') public emptyString(): void {}
  @Get('/') public root(): void {}
  @Get('/slash') public leadingSlash(): void {}
  @Post() public create(): void {}
  @Get(':id') public get(): void {}
}

export class NoBaseController extends BaseController {
  @Get('ping') public ping(): void {}
  @Get() public pong(): void {}
}

@BasePath('api/v2/things')
export class NestedController extends BaseController {
  @Get() public all(): void {}
  @Get('/') public index(): void {}
}

@BasePath('/')
export class RootController extends BaseController {
  @Get('health') public health(): void {}
  @Get() public bare(): void {}
  @Get('/') public slash(): void {}
}

@BasePath('/lead')
export class LeadingSlashBaseController extends BaseController {
  @Get('x') public x(): void {}
}

@BasePath({ config: 'admin.base', default: '/admin/' })
export class ConfiguredController extends BaseController {
  @Get() public ping(): void {}
}
