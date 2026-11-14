import { BasePath, Get, HTTP_STATUS_CODE, Ok, Post, RateLimit, RawJsonResponse, documentedAnswer } from '@spinajs/http';

import { RateLimitedBase } from '../rate-limited-base.js';

const unmarked = (retryAfter: number) => new RawJsonResponse(HTTP_STATUS_CODE.TOO_MANY_REQUESTS, { retryAfter });
const marked = documentedAnswer((retryAfter: number) => new RawJsonResponse(HTTP_STATUS_CODE.SERVICE_UNAVAILABLE, { retryAfter }), { status: 503, description: 'Busy, come back later', retryAfter: true });

/**
 * Rate-limited routes, one per documentation case.
 * @tags RateLimited
 */
@BasePath('limits')
export class RateLimitedController extends RateLimitedBase {
  @Post()
  @RateLimit(5, 60)
  public limited() {
    return new Ok();
  }

  @Post()
  @RateLimit({ limit: 5, windowSeconds: 60, headers: true })
  public loud() {
    return new Ok();
  }

  @Post()
  @RateLimit({ config: false })
  public off() {
    return new Ok();
  }

  /**
   * A limited route whose 429 the JSDoc documents.
   * @response 429 {string} custom
   */
  @Post()
  @RateLimit(5, 60)
  public documented() {
    return new Ok();
  }

  @Post()
  @RateLimit({ limit: 5, windowSeconds: 60, answer: unmarked })
  public custom() {
    return new Ok();
  }

  @Post()
  @RateLimit({ limit: 5, windowSeconds: 60, answer: marked })
  public marked() {
    return new Ok();
  }

  @Post()
  @RateLimit({ limit: 5, windowSeconds: 60, headers: true, key: () => 'k' })
  public keyed() {
    return new Ok();
  }

  /**
   * A limited route with a typed success answer.
   * @returns {string} plain text
   */
  @Get()
  @RateLimit({ limit: 5, windowSeconds: 60, headers: true })
  public typed() {
    return new Ok('ok');
  }
}
