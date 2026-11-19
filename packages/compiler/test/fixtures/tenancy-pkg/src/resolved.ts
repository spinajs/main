import { BaseController, BasePath, Get } from '@spinajs/http';
import { Model, ModelBase, Primary } from '@spinajs/orm';
import * as http from '../vendor/tenancy-http/index.js';
import * as orm from '../vendor/tenancy-orm/index.js';
import { Tenant as Isolated, registerTenantModel as register } from '../vendor/tenancy-orm/index.js';

@Model('branches')
@Isolated({ column: 'branch_id' })
export class Branch extends ModelBase<Branch> {
  @Primary() public Id: number;
}

@Model('vaults')
@orm.Tenant({ isolation: 'schema' })
export class Vault extends ModelBase<Vault> {
  @Primary() public Id: number;
}

@Model('notes')
export class Note extends ModelBase<Note> {
  @Primary() public Id: number;
}

register(Note, { rls: false });

@BasePath('resolved')
export class ResolvedController extends BaseController {
  @Get('scoped')
  @http.TenantRoute()
  public async scoped(): Promise<void> {}

  @Get('all')
  @http.AllTenants('namespace import')
  public async all(): Promise<void> {}
}
