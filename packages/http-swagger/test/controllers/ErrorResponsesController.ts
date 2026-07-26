import { BaseController, BasePath, Get, Post, Ok, Param, Body } from '@spinajs/http';
import { Schema } from '@spinajs/validation';

/**
 * App-specific error envelope used to verify named-schema expansion in typed
 * `@response` tags and request bodies.
 */
@Schema({
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
    requestId: { type: 'string' },
  },
  example: { error: { code: 'NOT_FOUND', message: 'no such thing' }, requestId: 'req-1' },
})
export class TestErrorEnvelopeDto {
  public error!: { code: string; message: string };
  public requestId?: string;
}

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

  /**
   * Endpoint documenting a NAMED typed error response — should expand into a
   * `$ref` to `#/components/schemas/TestErrorEnvelopeDto`.
   * @response 404 {TestErrorEnvelopeDto} Named error envelope
   * @example
   * <caption>Not found sample</caption>
   * {"error": {"code": "NOT_FOUND", "message": "no such thing"}}
   */
  @Get('named-typed/:id')
  public async namedTyped(@Param() id: number) {
    return new Ok({ id });
  }

  /**
   * Request body documented via a named DTO type — should expand into a `$ref`.
   * @param payload {TestErrorEnvelopeDto} The envelope payload
   */
  @Post('named-body')
  public async namedBody(@Body() payload: unknown) {
    return new Ok({ payload });
  }
}
