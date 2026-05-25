import { BaseController, BasePath, Get, Post, Del, Ok, Param } from '@spinajs/http';

/**
 * Test-only equivalent of rbac-http's @Resource decorator.
 * Writes metadata to the same global symbol (`Symbol.for('ACL_CONTROLLER_DESCRIPTOR_SYMBOL')`)
 * that http-swagger reads — so we can exercise RBAC extraction without depending
 * on @spinajs/rbac-http in this test suite.
 */
const ACL_SYMBOL = Symbol.for('ACL_CONTROLLER_DESCRIPTOR_SYMBOL');

interface IAclMeta {
  Resource: string;
  Permission: string[];
  Routes: Map<string, { Permission: string[] }>;
}

function aclMeta(target: any): IAclMeta {
  const proto = target.prototype || target;
  let m: IAclMeta = Reflect.getMetadata(ACL_SYMBOL, proto);
  if (!m) {
    m = { Resource: '', Permission: [], Routes: new Map() };
    Reflect.defineMetadata(ACL_SYMBOL, m, proto);
  }
  return m;
}

function Resource(resource: string, permission: string[] = ['readOwn']) {
  return (target: any) => {
    const m = aclMeta(target);
    m.Resource = resource;
    m.Permission = permission;
  };
}

function Permission(permission: string[]) {
  return (target: any, propertyKey: string) => {
    const m = aclMeta(target);
    m.Routes.set(propertyKey, { Permission: permission });
  };
}

/**
 * Demonstrates RBAC metadata extraction from controller and route decorators.
 * @tags RbacTests
 */
@BasePath('rbac')
@Resource('test.resource', ['readOwn'])
export class RbacController extends BaseController {
  /**
   * Route without an explicit @Permission — should fall back to the controller-level one.
   */
  @Get('inherited')
  public async inherited() {
    return new Ok({ ok: true });
  }

  /**
   * Route with its own @Permission(['readAny']) — should override the controller default.
   */
  @Get(':id')
  @Permission(['readAny'])
  public async readAny(@Param() id: number) {
    return new Ok({ id });
  }

  /**
   * Route accepting multiple alternative permissions.
   */
  @Post('/')
  @Permission(['createOwn', 'createAny'])
  public async create() {
    return new Ok({ created: true });
  }

  /**
   * Route requiring deleteAny.
   */
  @Del(':id')
  @Permission(['deleteAny'])
  public async remove(@Param() id: number) {
    return new Ok({ deleted: id });
  }
}
