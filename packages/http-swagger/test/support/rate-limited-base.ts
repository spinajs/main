import { BaseController, Ok, Post, RateLimit } from '@spinajs/http';

/** Outside the scanned dirs: its routes are documented only through a subclass. */
export abstract class RateLimitedBase extends BaseController {
  @Post()
  @RateLimit(5, 60)
  public inherited() {
    return new Ok();
  }
}
