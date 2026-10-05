import { BaseController, BasePath, Get, Post, Del, Ok, Param } from '@spinajs/http';
import { access, allowAnonymous } from '../support/fake-access.js';

/**
 * Demonstrates @Access extraction from controller and route decorators.
 * @tags AccessTests
 */
@BasePath('access')
@access('test:read')
export class AccessController extends BaseController {
  /**
   * Route without its own @Access, so it falls back to the controller-level one.
   */
  @Get('inherited')
  public async inherited() {
    return new Ok({ ok: true });
  }

  /**
   * Route with its own @Access, which the controller-level one still narrows.
   */
  @Get(':id')
  @access('test:update')
  public async readOne(@Param() id: number) {
    return new Ok({ id });
  }

  /**
   * Route accepting alternative permissions in a non-root domain.
   */
  @Post('/')
  @access(['test:create', 'test:import'], { domain: 'tenant' })
  public async create() {
    return new Ok({ created: true });
  }

  /**
   * Route that lets anonymous callers through the authentication step.
   * @response 403 Not yours
   */
  @Del(':id')
  @allowAnonymous()
  @access('test:delete')
  public async remove(@Param() id: number) {
    return new Ok({ deleted: id });
  }
}
