declare function BasePath(p: string): ClassDecorator;
declare function Get(p?: string): MethodDecorator;
declare function Public(reason: string): ClassDecorator & MethodDecorator;

@BasePath('fake')
@Public('not the framework decorator')
export class FakeController {
  @Get('x')
  @Public('neither is this')
  public x(): void {}
}
