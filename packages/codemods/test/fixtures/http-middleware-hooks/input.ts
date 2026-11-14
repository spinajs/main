import * as http from '@spinajs/http';
import { ErrorHandlerMiddleware, NotFoundMiddleware, RouteMiddleware, ServerMiddleware } from '@spinajs/http';

export class Stamp extends ServerMiddleware {
  public Order = 2;

  public before() {
    return (_req: unknown, _res: unknown, next: () => void) => next();
  }

  public after = () => null;

  public isEnabled() {
    return true;
  }
}

export class Qualified extends http.ServerMiddleware {
  public before() {
    return null;
  }
}

class LocalBase extends ServerMiddleware {}

export class Inherited extends LocalBase {
  public after() {
    return null;
  }
}

export class Missing extends NotFoundMiddleware {
  public before() {
    return null;
  }
}

export class Failing extends ErrorHandlerMiddleware {
  public after() {
    return null;
  }
}

export class Positional extends RouteMiddleware {
  public isEnabled() {
    return true;
  }

  public async onBefore(req: unknown, res: unknown) {
    void req;
    void res;
  }

  public async onAfter(ctx: unknown) {
    void ctx;
  }

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
