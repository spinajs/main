import * as http from '@spinajs/http';
import { ErrorHandlerMiddleware, NotFoundMiddleware, RouteMiddleware, ServerMiddleware } from '@spinajs/http';

export class Stamp extends ServerMiddleware {
  public Order = 2;

  // TODO(spinajs-4): before()/after() are removed, use onBefore(ctx), onAfter(ctx), onFinish(ctx) or handler(), see docs/http/15-server-middlewares.md#migrating-from-before-and-after
  public before() {
    return (_req: unknown, _res: unknown, next: () => void) => next();
  }

  // TODO(spinajs-4): before()/after() are removed, use onBefore(ctx), onAfter(ctx), onFinish(ctx) or handler(), see docs/http/15-server-middlewares.md#migrating-from-before-and-after
  public after = () => null;

  public isEnabled() {
    return true;
  }
}

export class Qualified extends http.ServerMiddleware {
  // TODO(spinajs-4): before()/after() are removed, use onBefore(ctx), onAfter(ctx), onFinish(ctx) or handler(), see docs/http/15-server-middlewares.md#migrating-from-before-and-after
  public before() {
    return null;
  }
}

class LocalBase extends ServerMiddleware {}

export class Inherited extends LocalBase {
  // TODO(spinajs-4): before()/after() are removed, use onBefore(ctx), onAfter(ctx), onFinish(ctx) or handler(), see docs/http/15-server-middlewares.md#migrating-from-before-and-after
  public after() {
    return null;
  }
}

export class Missing extends NotFoundMiddleware {
  // TODO(spinajs-4): before()/after() are removed, override reply() and return the Response, see docs/http/15-server-middlewares.md#migrating-from-before-and-after
  public before() {
    return null;
  }
}

export class Failing extends ErrorHandlerMiddleware {
  // TODO(spinajs-4): before()/after() are removed, override reply() and return the Response, see docs/http/15-server-middlewares.md#migrating-from-before-and-after
  public after() {
    return null;
  }
}

export class Positional extends RouteMiddleware {
  public isEnabled() {
    return true;
  }

  // TODO(spinajs-4): route middleware hooks take one context, onBefore(ctx) / onAfter(ctx), see docs/http/14-route-middlewares.md#migrating-from-the-positional-hooks
  public async onBefore(req: unknown, res: unknown) {
    void req;
    void res;
  }

  public async onAfter(ctx: unknown) {
    void ctx;
  }

  // TODO(spinajs-4): onResponse is removed, move it to onAfter(ctx) (the reply is ctx.response), see docs/http/14-route-middlewares.md#migrating-from-the-positional-hooks
  public async onResponse(data: unknown) {
    void data;
  }

  public before() {}
}

export class NotAMiddleware {
  public before() {
    return null;
  }

  public onResponse() {}
}
