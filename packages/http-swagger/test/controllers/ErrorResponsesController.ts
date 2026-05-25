import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';

/**
 * Exercises every documented standard error response so we can verify the
 * builder emits `$ref` to reusable `components.responses.*` entries.
 * @tags ErrorResponseTests
 */
@BasePath('errors')
export class ErrorResponsesController extends BaseController {
  /**
   * Endpoint documenting most common error codes.
   * @response 400 Malformed request
   * @response 401 Session required
   * @response 403 Forbidden — caller lacks permission
   * @response 404 Resource not found
   * @response 409 Conflict with existing resource
   * @response 422 Validation failed
   * @response 500 Unexpected server error
   */
  @Get(':id')
  public async lookup(@Param() id: number) {
    return new Ok({ id });
  }

  /**
   * Endpoint documenting a typed response that should stay inline (NOT a $ref).
   * @response 400 {string} Custom inline error string
   */
  @Get('inline-typed/:id')
  public async inlineTyped(@Param() id: number) {
    return new Ok({ id });
  }

  /**
   * Endpoint with no documented error responses — should still get the default 200.
   */
  @Get('clean')
  public async clean() {
    return new Ok({ ok: true });
  }
}
