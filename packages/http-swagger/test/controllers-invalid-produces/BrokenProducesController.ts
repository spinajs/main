import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

/**
 * A route whose `@produces` is not a media type. Kept out of `test/controllers`, which every suite documents.
 */
@BasePath('broken')
export class BrokenProducesController extends BaseController {
  /**
   * Rows
   * @produces csv
   * @returns The rows
   */
  @Get('ping')
  public async ping() {
    return new Ok({ pong: true });
  }
}
