import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

/**
 * Health check and status endpoints.
 */
@BasePath('status')
export class StatusController extends BaseController {
  /**
   * Health check endpoint
   * @returns Health status object
   */
  @Get('health')
  public async health() {
    return new Ok({ status: 'ok' });
  }

  /**
   * Get application version
   * @returns Version string
   * @tags System
   */
  @Get('version')
  public async version() {
    return new Ok({ version: '1.0.0' });
  }
}
