declare function BasePath(p: string): ClassDecorator;
declare function Post(p?: string): MethodDecorator;
declare function Idempotent(options?: { required?: boolean }): MethodDecorator;

@BasePath('fake-idem')
export class FakeIdemController {
  @Post('x')
  @Idempotent({ required: true })
  public x(): void {}
}
