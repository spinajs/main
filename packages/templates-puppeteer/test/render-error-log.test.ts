import 'mocha';
import * as fs from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { expect } from 'chai';
import { Configuration, FrameworkConfiguration, Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { ICommonTargetOptions, ILogEntry, ISerializedError, LogTarget } from '@spinajs/log';
import { IRenderProgress, RenderPhase } from '@spinajs/templates';
import { Page } from 'puppeteer';

import { PuppeteerRenderer, IPuppeteerRendererOptions } from '../src/index.js';

const SIGNED_PATH_SEGMENT = '7d3e1f0a9b8c4d2e6f5a4b3c2d1e0f98';
const REFUSED_TOKEN = 'planted-goto-refused';
const EMPTY_TOKEN = 'planted-goto-empty';
const WRAPPED_TOKEN = 'planted-goto-wrapped';
const USER = 'pl4nteduser';
const PASSWORD = 'planted-password';
const TEXT_TOKEN = 'planted-goto-text';
const TIMEOUT_TOKEN = 'planted-goto-timeout';
const HOSTILE_TOKEN = 'planted-hostile';
const AGGREGATE_TOKEN = 'planted-aggregate';
const CYCLE_TOKEN = 'planted-cycle';
const OBJECT_TOKEN = 'planted-object';
const FRAME_TOKEN = 'planted-frame-query';
const APP_TOKEN = 'planted-app-script';
const EVALUATE_TOKEN = 'planted-evaluate';
const PLANTED = [
  SIGNED_PATH_SEGMENT,
  REFUSED_TOKEN,
  EMPTY_TOKEN,
  WRAPPED_TOKEN,
  TEXT_TOKEN,
  TIMEOUT_TOKEN,
  HOSTILE_TOKEN,
  AGGREGATE_TOKEN,
  CYCLE_TOKEN,
  OBJECT_TOKEN,
  FRAME_TOKEN,
  APP_TOKEN,
  EVALUATE_TOKEN,
  USER,
  PASSWORD,
  'planted',
];

const captured: ILogEntry[] = [];

@Injectable('PuppeteerRenderErrorCapture')
export class CaptureTarget extends LogTarget<ICommonTargetOptions> {
  public write(entry: ILogEntry): void {
    captured.push(entry);
  }
}

// an application's code may throw any value, a plain string included
function rethrowAs(reason: unknown): never {
  throw reason;
}

/** A renderer whose `prepare` navigates or fails, as a subclass of the documented seam may do. */
@Injectable()
class NavigatingRenderer extends PuppeteerRenderer {
  @Config('templates.puppeteerRenderErrorTest')
  protected Options: IPuppeteerRendererOptions;

  public get Type() {
    return 'puppeteer-render-error-test';
  }

  public get Extension() {
    return '.render-error-test';
  }

  public renderWith(filePath: string, onProgress: (progress: IRenderProgress) => void, fill: (page: Page) => Promise<void>): Promise<void> {
    return this.renderContentToFile(filePath, { onProgress }, async (page, _httpPort, markLoading) => {
      markLoading();
      await fill(page);
    });
  }

  protected async performRender(_page: Page, _filePath: string): Promise<void> {}
}

class RenderErrorTestConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Capture', type: 'PuppeteerRenderErrorCapture' }],
        rules: [{ name: '*', level: 'trace', target: 'Capture' }],
      },
      templates: {
        puppeteerRenderErrorTest: {
          args: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          },
          renderTimeout: 30000,
        },
      },
    };
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the test server is not listening on a TCP port');
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

interface RenderCase {
  url: string;
  thrown: unknown;
  entries: ILogEntry[];
  progress: IRenderProgress[];
  rejected: unknown;
}

const asError = (value: unknown): Error => {
  if (!(value instanceof Error)) throw new Error(`not an Error: ${inspect(value)}`);
  return value;
};
const renderErrorsOf = (run: RenderCase) => run.entries.filter((entry) => entry.Variables.error !== undefined);
// the log replaces a logged Error with its serialized record, the cause chain and inner errors folded into `stack`
const loggedError = (entry: ILogEntry): ISerializedError => {
  const error: unknown = entry.Variables.error;
  if (typeof error !== 'object' || error === null || !('message' in error) || typeof error.message !== 'string') {
    throw new Error(`not a serialized error: ${inspect(error)}`);
  }
  return {
    name: 'name' in error ? String(error.name) : '',
    message: error.message,
    stack: 'stack' in error ? String(error.stack) : undefined,
    code: 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : undefined,
  };
};
const failedMessages = (run: RenderCase) => run.progress.filter((progress) => progress.phase === RenderPhase.Failed).map((progress) => progress.message);

function withField(error: Error, key: string, descriptor: PropertyDescriptor): Error {
  Object.defineProperty(error, key, descriptor);
  return error;
}

describe('PuppeteerRenderer render errors', function () {
  this.timeout(120000);

  let sandbox: string;
  let refusedPort: number;
  let emptyPort: number;
  let emptyServer: Server;
  let silentPort: number;
  let silentServer: Server;
  let pagePort: number;
  let pageServer: Server;
  const root = pathToFileURL(process.cwd()).href;
  let pastCapRead = false;
  const runs = new Map<string, RenderCase>();
  const runOf = (name: string): RenderCase => {
    const run = runs.get(name);
    if (run === undefined) throw new Error(`no render case ${name}`);
    return run;
  };

  before(async () => {
    sandbox = fs.mkdtempSync(join(tmpdir(), 'spinajs-puppeteer-render-error-'));
    fs.writeFileSync(join(sandbox, 'planted-outside.js'), '\n');

    const closed = createServer();
    refusedPort = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    // drops every connection: Chromium reports net::ERR_EMPTY_RESPONSE
    emptyServer = createServer((request) => request.socket.destroy());
    emptyPort = await listen(emptyServer);
    silentServer = createServer(() => undefined);
    silentPort = await listen(silentServer);
    pageServer = createServer((request, response) => {
      if (request.url?.startsWith('/app.js') === true) {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(`window.boom = function () { throw new Error('boom at http://127.0.0.1:9/x?token=${EVALUATE_TOKEN}'); };\n`);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<html><head><script src="/app.js?token=${APP_TOKEN}"></script></head><body></body></html>`);
    });
    pagePort = await listen(pageServer);

    DI.clearCache();
    DI.register(RenderErrorTestConf).as(Configuration);
    await DI.resolve(Configuration);
    const renderer = await DI.resolve(NavigatingRenderer);

    const goto = (url: string, timeout?: number) => async (page: Page) => {
      await page.goto(url, { timeout });
    };
    const cycleSelf = new Error(`self at http://127.0.0.1:9/s?token=${CYCLE_TOKEN}`);
    cycleSelf.cause = cycleSelf;
    const cycleA = new Error(`a at http://127.0.0.1:9/a?token=${CYCLE_TOKEN}`);
    const cycleB = new Error(`b at http://127.0.0.1:9/b?token=${CYCLE_TOKEN}`, { cause: cycleA });
    cycleA.cause = cycleB;
    let chain: Error | undefined;
    for (let level = 14; level >= 0; level--) {
      chain = new Error(`level ${level}`, { cause: chain });
      if (level === 11) {
        withField(chain, 'name', {
          get() {
            pastCapRead = true;
            return 'Error';
          },
        });
      }
    }
    const crafted = new Error('crafted frames');
    crafted.stack = [
      'Error: crafted frames',
      `    at missing (${root}/missing-planted.js:3:4)`,
      `    at query (${root}/test/render-error-log.test.ts?token=${FRAME_TOKEN}:5:6)`,
      `    at climb (${root}/test/../../../planted-climb.js:7:8)`,
      `    at outside (${pathToFileURL(sandbox).href}/planted-outside.js:9:10)`,
      `    at own (${root}/test/render-error-log.test.ts:1:2)`,
    ].join('\n');

    const cases: Record<string, { url?: string; thrown?: unknown; fill?: (page: Page) => Promise<void> }> = {
      refused: { url: `http://127.0.0.1:${refusedPort}/doc/${SIGNED_PATH_SEGMENT}?X-Amz-Signature=${REFUSED_TOKEN}` },
      userinfo: { url: `http://${USER}:${PASSWORD}@127.0.0.1:${refusedPort}/doc` },
      empty: { url: `http://127.0.0.1:${emptyPort}/report/${SIGNED_PATH_SEGMENT}?token=${EMPTY_TOKEN}` },
      timeout: { url: `http://127.0.0.1:${silentPort}/slow?token=${TIMEOUT_TOKEN}`, fill: goto(`http://127.0.0.1:${silentPort}/slow?token=${TIMEOUT_TOKEN}`, 2000) },
      wrapped: {
        url: `http://127.0.0.1:${refusedPort}/report?token=${WRAPPED_TOKEN}`,
        fill: async (page) => {
          try {
            await page.goto(`http://127.0.0.1:${refusedPort}/report?token=${WRAPPED_TOKEN}`);
          } catch (err) {
            throw new Error('cannot open the report', { cause: err });
          }
        },
      },
      text: {
        url: `http://127.0.0.1:${refusedPort}/text?token=${TEXT_TOKEN}`,
        fill: async (page) => {
          try {
            await page.goto(`http://127.0.0.1:${refusedPort}/text?token=${TEXT_TOKEN}`);
          } catch (err) {
            rethrowAs(err instanceof Error ? err.message : err);
          }
        },
      },
      'message undefined': { thrown: withField(new Error(`hostile at http://127.0.0.1:9/h?token=${HOSTILE_TOKEN}`), 'message', { value: undefined }) },
      'stack null': { thrown: withField(new Error(`hostile at http://127.0.0.1:9/h?token=${HOSTILE_TOKEN}`), 'stack', { value: null }) },
      'message getter throws': {
        thrown: withField(new Error('hostile'), 'message', {
          get() {
            throw new Error('message getter boom');
          },
        }),
      },
      'stack trap throws': {
        thrown: new Proxy(new Error(`hostile at http://127.0.0.1:9/h?token=${HOSTILE_TOKEN}`), {
          get(target, key, receiver): unknown {
            if (key === 'stack') throw new Error('proxy trap boom');
            return Reflect.get(target, key, receiver);
          },
        }),
      },
      'prototype trap throws': {
        thrown: new Proxy(new Error('hostile'), {
          getPrototypeOf() {
            throw new Error('prototype trap boom');
          },
        }),
      },
      'long chain': { thrown: chain },
      enoent: {
        fill: async () => {
          await fs.promises.readFile(join(sandbox, 'missing.txt'));
        },
      },
      aggregate: { thrown: Object.assign(new AggregateError([new Error(`inner at http://127.0.0.1:9/a?token=${AGGREGATE_TOKEN}`)], ''), { code: 'ECONNREFUSED' }) },
      'self cycle': { thrown: cycleSelf },
      'two-error cycle': { thrown: cycleA },
      'plain object': { thrown: { message: `net::ERR_FAILED at http://127.0.0.1:9/om?token=${OBJECT_TOKEN}` } },
      'crafted frames': { thrown: crafted },
      evaluate: {
        fill: async (page) => {
          await page.goto(`http://127.0.0.1:${pagePort}/`);
          await page.evaluate('window.boom()');
        },
      },
    };

    for (const [name, definition] of Object.entries(cases)) {
      const url = definition.url ?? '';
      const fill = definition.fill ?? (definition.thrown !== undefined ? async () => rethrowAs(definition.thrown) : goto(url));
      const run: RenderCase = { url, thrown: definition.thrown, entries: [], progress: [], rejected: undefined };
      captured.length = 0;
      try {
        await renderer.renderWith(join(sandbox, `${name.replace(/\W/g, '-')}.render-error-test`), (progress) => run.progress.push(progress), fill);
      } catch (err) {
        run.rejected = err;
      }
      await new Promise((resolve) => setImmediate(resolve));
      run.entries = [...captured];
      runs.set(name, run);
    }
  });

  after(async () => {
    await DI.dispose();
    await close(emptyServer);
    await close(silentServer);
    await close(pageServer);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('logs a refused navigation twice with the error code, the host, the port and the plain path', () => {
    const errors = renderErrorsOf(runOf('refused'));
    expect(errors).to.have.length(2);
    for (const entry of errors) {
      expect(loggedError(entry).name).to.eq('Error');
      expect(loggedError(entry).message).to.eq(`net::ERR_CONNECTION_REFUSED at http://127.0.0.1:${refusedPort}/doc/***`);
      expect(loggedError(entry).stack).to.match(/^Error: net::ERR_CONNECTION_REFUSED at http:\/\/127\.0\.0\.1:\d+\/doc\/\*\*\*\n {4}at .*:\d+:\d+/);
    }
  });

  it('keeps the file of a stack frame of a module under the working directory', () => {
    for (const entry of renderErrorsOf(runOf('refused'))) expect(loggedError(entry).stack).to.contain(`${root}/test/render-error-log.test.ts:`);
  });

  it('masks a file frame that is missing, carries a query, climbs or lies outside the working directory', () => {
    const errors = renderErrorsOf(runOf('crafted frames'));
    expect(errors).to.have.length(2);
    for (const entry of errors) {
      expect(loggedError(entry).stack).to.eq(
        [
          'Error: crafted frames',
          '    at missing (file://***:3:4)',
          '    at query (file://***:5:6)',
          '    at climb (file://***:7:8)',
          '    at outside (file://***:9:10)',
          `    at own (${root}/test/render-error-log.test.ts:1:2)`,
        ].join('\n'),
      );
    }
  });

  it('logs an evaluate error with its message and the page frame redacted', () => {
    const errors = renderErrorsOf(runOf('evaluate'));
    expect(errors).to.have.length(2);
    for (const entry of errors) {
      expect(loggedError(entry).message).to.eq('boom at http://127.0.0.1:9/x');
      expect(loggedError(entry).stack).to.match(/\n {4}at window\.boom \(http:\/\/127\.0\.0\.1:\d+\/app\.js:\d+:\d+\)$/);
      expect(loggedError(entry).stack).to.contain(`127.0.0.1:${pagePort}/app.js:`);
    }
  });

  it('logs a navigation to a URL with credentials without them', () => {
    const errors = renderErrorsOf(runOf('userinfo'));
    expect(errors).to.have.length(2);
    for (const entry of errors) expect(loggedError(entry).message).to.eq(`net::ERR_CONNECTION_REFUSED at http://127.0.0.1:${refusedPort}/doc`);
  });

  it('logs a navigation the server drops with its error code and the URL redacted', () => {
    const errors = renderErrorsOf(runOf('empty'));
    expect(errors).to.have.length(2);
    for (const entry of errors) expect(loggedError(entry).message).to.eq(`net::ERR_EMPTY_RESPONSE at http://127.0.0.1:${emptyPort}/report/***`);
  });

  it('logs the cause of a wrapped navigation error with its URL redacted', () => {
    const errors = renderErrorsOf(runOf('wrapped'));
    expect(errors).to.have.length(2);
    for (const entry of errors) {
      expect(loggedError(entry).message).to.eq('cannot open the report');
      expect(loggedError(entry).stack).to.contain(`\nCaused by: Error: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:${refusedPort}/report\n`);
    }
  });

  it('logs a navigation timeout with its class and message', () => {
    const errors = renderErrorsOf(runOf('timeout'));
    expect(errors).to.have.length(2);
    for (const entry of errors) expect(loggedError(entry)).to.include({ name: 'TimeoutError', message: 'Navigation timeout of 2000 ms exceeded' });
  });

  it('logs an error thrown as text with its URL redacted', () => {
    const errors = renderErrorsOf(runOf('text'));
    expect(errors.map((entry) => entry.Variables.error)).to.deep.eq([
      `net::ERR_CONNECTION_REFUSED at http://127.0.0.1:${refusedPort}/text`,
      `net::ERR_CONNECTION_REFUSED at http://127.0.0.1:${refusedPort}/text`,
    ]);
  });

  it('logs a thrown plain object by its tag only', () => {
    expect(renderErrorsOf(runOf('plain object')).map((entry) => entry.Variables.error)).to.deep.eq(['[object Object]', '[object Object]']);
  });

  for (const name of ['message undefined', 'stack null', 'message getter throws', 'stack trap throws', 'prototype trap throws']) {
    it(`still logs and rejects with the original error when its ${name}`, () => {
      const run = runOf(name);
      expect(run.rejected === run.thrown, 'the render rejects with the thrown object').to.eq(true);
      expect(renderErrorsOf(run)).to.have.length(2);
    });
  }

  it("logs a Node error's code", () => {
    const errors = renderErrorsOf(runOf('enoent'));
    expect(errors).to.have.length(2);
    for (const entry of errors) expect(loggedError(entry).code).to.eq('ENOENT');
  });

  it('logs the code and the inner errors of an AggregateError, redacted', () => {
    const errors = renderErrorsOf(runOf('aggregate'));
    expect(errors).to.have.length(2);
    for (const entry of errors) {
      expect(loggedError(entry).code).to.eq('ECONNREFUSED');
      expect(loggedError(entry).stack).to.contain('Caused by: Error: inner at http://127.0.0.1:9/a\n');
    }
  });

  it('prints each error of a cause cycle once', () => {
    const cycles: [string, number][] = [
      ['self cycle', 0],
      ['two-error cycle', 1],
    ];
    for (const [name, causes] of cycles) {
      const run = runOf(name);
      expect(run.rejected === run.thrown, `${name}: the render rejects with the thrown object`).to.eq(true);
      const errors = renderErrorsOf(run);
      expect(errors).to.have.length(2);
      for (const entry of errors) expect(String(loggedError(entry).stack).split('Caused by:').length - 1, name).to.eq(causes);
    }
  });

  it('stops copying a cause chain after ten levels', () => {
    const run = runOf('long chain');
    expect(run.rejected === run.thrown, 'the render rejects with the thrown object').to.eq(true);
    expect(renderErrorsOf(run)).to.have.length(2);
    expect(pastCapRead, 'an error past the cap was read').to.eq(false);
  });

  it('reports the failed phase with the redacted error message', () => {
    expect(failedMessages(runOf('refused'))).to.deep.eq([`net::ERR_CONNECTION_REFUSED at http://127.0.0.1:${refusedPort}/doc/***`]);
    expect(failedMessages(runOf('userinfo'))).to.deep.eq([`net::ERR_CONNECTION_REFUSED at http://127.0.0.1:${refusedPort}/doc`]);
    expect(failedMessages(runOf('empty'))).to.deep.eq([`net::ERR_EMPTY_RESPONSE at http://127.0.0.1:${emptyPort}/report/***`]);
    expect(failedMessages(runOf('text'))).to.deep.eq([`net::ERR_CONNECTION_REFUSED at http://127.0.0.1:${refusedPort}/text`]);
  });

  it('rejects with the navigation error unchanged: it belongs to the application', () => {
    expect(asError(runOf('refused').rejected).message).to.eq(`net::ERR_CONNECTION_REFUSED at ${runOf('refused').url}`);
    const wrapped = asError(runOf('wrapped').rejected);
    expect(wrapped.message).to.eq('cannot open the report');
    expect(asError(wrapped.cause).message).to.eq(`net::ERR_CONNECTION_REFUSED at ${runOf('wrapped').url}`);
    expect(runOf('text').rejected).to.eq(`net::ERR_CONNECTION_REFUSED at ${runOf('text').url}`);
  });

  it('prints no part of a planted token or credential at any level or in any progress message', () => {
    const text = inspect([...runs.values()].map((run) => [run.entries, run.progress]), { depth: 20, showHidden: true, breakLength: Infinity });
    for (const planted of PLANTED) expect(text).to.not.contain(planted);
  });
});
