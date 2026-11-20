import { BaseController, BasePath, Get } from '@spinajs/http';
import { Model, ModelBase, Primary } from '@spinajs/orm';
import { Country } from './models.js';

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

  @Get('scoped')
  @TenantRoute()
  public async scoped(): Promise<void> {}

  @Get('all')
  @AllTenants('a local decorator of the same name')
  public async all(): Promise<void> {}
}

declare function TenantRoute(): MethodDecorator;
declare function AllTenants(reason: string): MethodDecorator;
declare function registerTenantModel(model: unknown, options?: unknown): void;

registerTenantModel(Country, { isolation: 'row' });
