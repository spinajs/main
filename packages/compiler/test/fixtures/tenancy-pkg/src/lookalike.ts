import { BaseController, BasePath, Get } from '@spinajs/http';
import { Model, ModelBase, Primary } from '@spinajs/orm';

declare function Tenant(): ClassDecorator;
declare function NoTenant(): MethodDecorator;
declare function runAcrossTenants(reason: string, fn: () => Promise<void>): Promise<void>;

@Model('fakes')
@Tenant()
export class Fake extends ModelBase<Fake> {
  @Primary() public Id: number;
}

class Report {
  public acrossTenants(reason: string): this {
    void reason;
    return this;
  }
}

@BasePath('lookalike')
export class LookalikeController extends BaseController {
  @Get('open')
  @NoTenant()
  public async open(): Promise<void> {
    new Report().acrossTenants('a method of the same name');
    await runAcrossTenants('a local function of the same name', async () => undefined);
  }
}
