declare function BasePath(p: string): ClassDecorator;
declare function Get(p?: string): MethodDecorator;
declare function Access(p: string | string[]): ClassDecorator & MethodDecorator;
declare function AllowAnonymous(): ClassDecorator & MethodDecorator;

@BasePath('/open/')
@Access('admin:all')
@AllowAnonymous()
export class OpenController {
  @Get('/ping')
  public ping(): void {}
}
