import { BaseController, BasePath, Get, SseResponse } from '@spinajs/http';

/**
 * Live event streams.
 * @tags Streams
 */
@BasePath('streams')
export class StreamController extends BaseController {
  /**
   * Live ticks
   * @returns {SseResponse} Server-Sent Events stream of ticks
   */
  @Get('ticks')
  public ticks() {
    return new SseResponse((stream) => stream.close());
  }
}
