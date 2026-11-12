import { BasePath, BaseController, HTTP_STATUS_CODE, Ok, Post, RateLimit, RawJsonResponse, documentedAnswer } from '@spinajs/http';

const unavailable = (retryAfter: number) => new RawJsonResponse(HTTP_STATUS_CODE.SERVICE_UNAVAILABLE, { retryAfter });
const routeAnswer = documentedAnswer((retryAfter: number) => new RawJsonResponse(HTTP_STATUS_CODE.TOO_MANY_REQUESTS, { retryAfter }), { status: 429, description: 'Route limit hit', retryAfter: true });

/**
 * A controller-wide limit under each route's own.
 * @tags RateLimited
 */
@BasePath('class-limits')
@RateLimit({ limit: 100, windowSeconds: 60, headers: true })
export class ClassRateLimitedController extends BaseController {
  @Post()
  @RateLimit({ limit: 5, windowSeconds: 60, answer: routeAnswer })
  public narrowed() {
    return new Ok();
  }

  @Post()
  @RateLimit({ limit: 5, windowSeconds: 60, headers: true })
  public bothLoud() {
    return new Ok();
  }

  @Post()
  public wide() {
    return new Ok();
  }

  @Post()
  @RateLimit({ limit: 5, windowSeconds: 60, answer: unavailable })
  public unmarkedOwn() {
    return new Ok();
  }
}
