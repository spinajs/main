import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService, getFs } from '@spinajs/fs';
import type { fsNative, IFsLocalOptions } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { Log } from '@spinajs/log';

import { dir, releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, Controllers, Get, htmlResponse, HttpServer, Ok, Response } from '../src/index.js';

// Only a broken notFound.pug: no serverError.pug and no ok.pug, as in a build that skipped copy-static.
const MISSING = dir('./missing-templates');
// Only serverError.pug: every page template is missing, the first fallback is there.
const FALLBACK = dir('./fallback-templates');

class HtmlPage extends Response {
  public async execute() {
    return htmlResponse('page.pug', {});
  }
}

@BasePath('templated')
class TemplatedController extends BaseController {
  @Get()
  public page() {
    return new Ok({ hello: 'world' });
  }

  @Get()
  public rendered() {
    return new HtmlPage();
  }
}

function getHtml(path: string) {
  return req().get(path).set('Accept', 'text/html').timeout(5000);
}

describe('A missing error template', function () {
  this.timeout(20000);

  let warn: sinon.SinonSpy | undefined;
  let error: sinon.SinonSpy | undefined;
  let templates: fsNative<IFsLocalOptions> | undefined;
  let regularBasePath: string | undefined;

  before(async () => {
    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(TemplatedController).as(BaseController);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();

    // The provider instance outlives suites, so its base path is swapped rather than its configuration.
    templates = getFs('__fs_http_response_templates__') as fsNative<IFsLocalOptions>;
    regularBasePath = templates.Options.basePath;

    const log = DI.resolve(Log, ['http']);
    warn = sinon.spy(log, 'warn');
    error = sinon.spy(log, 'error');
  });

  after(async () => {
    if (templates) {
      templates.Options.basePath = regularBasePath;
    }
    warn?.restore();
    error?.restore();
    await releaseHttpServer();
    DI.unregister(TemplatedController as Class<unknown>);
    DI.uncache(TemplatedController);
    DI.uncache(BaseController);
  });

  beforeEach(() => {
    templates!.Options.basePath = MISSING;
    warn!.resetHistory();
    error!.resetHistory();
  });

  function logsWith(text: string) {
    return [...warn!.getCalls(), ...error!.getCalls()].filter((call) => JSON.stringify(call.args).includes(text));
  }

  it('answers an HTML 404 whose template fails to render with the fatal page', async () => {
    const res = await getHtml('templated/nowhere');

    expect(res).to.have.status(500);
    expect(res).to.have.header('content-type', /^text\/html/);
    const ticket = /TickeT no\. (\w+)/.exec(res.text)?.[1];
    expect(ticket, res.text).to.be.a('string');
    expect(logsWith(ticket!)).to.have.lengthOf(1);
  });

  it('answers an HTML page whose template file is missing with the fatal page', async () => {
    const res = await getHtml('templated/page');

    expect(res).to.have.status(500);
    expect(res).to.have.header('content-type', /^text\/html/);
    const ticket = /TickeT no\. (\w+)/.exec(res.text)?.[1];
    expect(ticket, res.text).to.be.a('string');
    expect(logsWith(ticket!)).to.have.lengthOf(1);
  });

  it('answers a missing page template with serverError.pug and one warning when that is present', async () => {
    templates!.Options.basePath = FALLBACK;

    const res = await getHtml('templated/page');

    expect(res).to.have.status(500);
    expect(res).to.have.header('content-type', /^text\/html/);
    expect(res.text).to.contain('fallback server error page');
    expect(warn!.getCalls().filter((call) => String(call.args[1]).startsWith('Cannot render html file'))).to.have.lengthOf(1);
    expect(logsWith('fatal page')).to.be.empty;
  });

  it('answers a client that does not accept HTML with plain text', async () => {
    const res = await req().get('templated/rendered').set('Accept', 'application/json').timeout(5000);

    expect(res).to.have.status(500);
    expect(res).to.have.header('content-type', /^text\/plain/);
    const ticket = /ticket (\w+)/.exec(res.text)?.[1];
    expect(ticket, res.text).to.be.a('string');
    expect(logsWith(ticket!)).to.have.lengthOf(1);
  });
});
