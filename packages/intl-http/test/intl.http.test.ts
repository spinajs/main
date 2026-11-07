import 'mocha';

import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import type { IMiddlewareContext, Request } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { Intl } from '@spinajs/intl';
import sinon from 'sinon';
import { req, TestConfiguration } from './common.js';
import { IntlHttpMiddleware } from '../src/index.js';
import { TestResponses } from './controllers/TestResponses.js';

describe('http & controller tests', function () {
  this.timeout(25000);

  const middlewareSandbox = sinon.createSandbox();

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    const server = await DI.resolve(HttpServer);

    server.start();
  });

  after(async () => {
    const server = await DI.resolve(HttpServer);
    server.stop();

    middlewareSandbox.restore();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('Pug resposne should be internationalized', async () => {
    let response = await req().get('responses/testPugIntl?lang=en').set('Accept', 'text/html').send();
    expect(response).to.have.status(200);
    expect(response).to.be.html;
    expect(response.text).to.eq('<html><head><title> Sample view</title></head><body>   <p>sample view</p><p>hello world</p></body></html>');

    response = await req().get('responses/testPugIntl?lang=pl').set('Accept', 'text/html').send();
    expect(response).to.have.status(200);
    expect(response).to.be.html;
    expect(response.text).to.eq('<html><head><title> Sample view</title></head><body>   <p>sample view</p><p>witaj świecie</p></body></html>');
  });

  it('Query param should be ok', async () => {
    const s = sinon.spy(TestResponses.prototype, 'testLangFromParam');

    let response = await req().get('responses/testLangFromParam?lang=en').set('Accept', 'application/json').send();
    expect(response).to.have.status(200);
    expect(s.callCount).to.eq(1);
    expect(s.args[0][0]).to.eq('en');
  });

  it('reads the language from a cookie: the built-in cookie parser (Order 0.5) runs before IntlHttpMiddleware (Order 1)', async () => {
    const response = await req().get('responses/testPugIntl').set('Accept', 'text/html').set('Cookie', 'lang=en').send();
    expect(response).to.have.status(200);
    expect(response.text).to.contain('<p>hello world</p>');
  });

  it('Query param should be ok with allowed languages', async () => {
    const s = sinon.spy(TestResponses.prototype, 'testLangAllowedLanguages');

    let response = await req().get('responses/testLangAllowedLanguages?lang=en').set('Accept', 'application/json').send();
    expect(response).to.have.status(200);
    expect(s.callCount).to.eq(1);
    expect(s.args[0][0]).to.eq('en');
  });

  it('Query param should not be ok with not allowed language', async () => {
    let response = await req().get('responses/testLangAllowedLanguages?lang=de').set('Accept', 'application/json').send();
    expect(response).to.have.status(400);
  });

  it('Query param faild with validation', async () => {
    let response = await req().get('responses/testLangAllowedLanguages?lang=de_dddd').set('Accept', 'application/json').send();
    expect(response).to.have.status(400);
  });

  it('Default language outside allowed languages should fail', async () => {
    let response = await req().get('responses/testLangDefaultNotAllowed').set('Accept', 'application/json').send();
    expect(response).to.have.status(400);
  });

  describe('IntlHttpMiddleware', () => {
    const context = (over: Record<string, unknown> = {}): IMiddlewareContext => {
      const req = { query: {}, cookies: {}, headers: {}, storage: {}, ...over } as unknown as Request;
      return { req, res: {} as never, storage: req.storage };
    };

    it('stores the explicit language, else intl.defaultLocale', async () => {
      const mw = await DI.resolve(IntlHttpMiddleware);
      const explicit = context({ query: { lang: 'en' } });
      const none = context();

      await mw.onBefore(explicit);
      await mw.onBefore(none);

      expect(explicit.storage.language).to.eq('en');
      expect(none.storage.language).to.eq('pl');
    });

    it('throws InvalidArgument for a value that is not 2 to 5 characters', async () => {
      const mw = await DI.resolve(IntlHttpMiddleware);
      expect(() => mw.onBefore(context({ headers: { 'x-lang': 'toolong' } }))).to.throw(InvalidArgument);
    });

    it('a subclass changes the detection with detectLanguage()', async () => {
      class FromHost extends IntlHttpMiddleware {
        protected detectLanguage(req: Request): string {
          const detected = super.detectLanguage(req);
          return req.hostname === 'shop.example.de' && detected === this.defaultLocale ? 'de' : detected;
        }
      }
      const mw = await DI.resolve(FromHost);
      const derived = context({ hostname: 'shop.example.de' });
      const explicit = context({ hostname: 'shop.example.de', query: { lang: 'en' } });

      await mw.onBefore(derived);
      await mw.onBefore(explicit);

      expect(derived.storage.language).to.eq('de');
      expect(explicit.storage.language).to.eq('en');
    });

    it('answers 400 through the server for a bad language on any path', async () => {
      const response = await req().get('responses/testLangFromParam?lang=toolong').set('Accept', 'application/json').send();
      expect(response).to.have.status(400);
    });
  });
});
