import { BasePath, BaseController, Get, Middleware, TemplateResponse, Ok, RouteMiddleware } from '@spinajs/http';
import type { IMiddlewareContext } from '@spinajs/http';
import { Lang } from '../../src/index.js';

class VaryOrigin extends RouteMiddleware {
  public onBefore({ res }: IMiddlewareContext): void {
    res.vary('Origin');
  }
}

@BasePath('responses')
export class TestResponses extends BaseController {
  @Get()
  public testPugIntl() {
    return new TemplateResponse('test-view-intl.pug', { sampleText: 'witaj świecie' });
  }

  @Get()
  public testLangFromParam(@Lang() lang: string) {
    return new Ok({ lang });
  }

  @Get()
  public testLangAllowedLanguages(@Lang(['en', 'pl']) lang: string) {
    return new Ok({ lang });
  }

  @Get()
  public testLangDefaultNotAllowed(@Lang(['en', 'de']) lang: string) {
    return new Ok({ lang });
  }

  @Get()
  public testOwnContentLanguage() {
    return new Ok({ ok: true }, { Headers: [{ Name: 'Content-Language', Value: 'de' }] });
  }

  @Get()
  public testOwnVary() {
    return new Ok({ ok: true }, { Headers: [{ Name: 'Vary', Value: 'Accept, cookie' }] });
  }

  @Get()
  @Middleware(VaryOrigin)
  public testVaryOrigin() {
    return new Ok({ ok: true });
  }
}
