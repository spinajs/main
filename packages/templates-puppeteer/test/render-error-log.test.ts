import 'mocha';
import * as fs from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const PLANTED = [SIGNED_PATH_SEGMENT, REFUSED_TOKEN, EMPTY_TOKEN, WRAPPED_TOKEN, TEXT_TOKEN, TIMEOUT_TOKEN, USER, PASSWORD, 'planted'];

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

/** A renderer whose `prepare` navigates, as a subclass of the documented seam may do. */
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

  public renderUrlToFile(url: string, filePath: string, onProgress: (progress: IRenderProgress) => void, rethrow: 'as is' | 'wrapped' | 'as text', timeout?: number): Promise<void> {
    return this.renderContentToFile(filePath, { onProgress }, async (page, _httpPort, markLoading) => {
      markLoading();
      try {
        await page.goto(url, { timeout });
      } catch (err) {
        if (rethrow === 'wrapped') throw new Error('cannot open the report', { cause: err });
        rethrowAs(rethrow === 'as text' && err instanceof Error ? err.message : err);
      }
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

interface RenderCase {
  url: string;
  entries: ILogEntry[];
  progress: IRenderProgress[];
  rejected: unknown;
}

const asError = (value: unknown): Error => {
  if (!(value instanceof Error)) throw new Error(`not an Error: ${inspect(value)}`);
  return value;
};
const renderErrorsOf = (run: RenderCase) => run.entries.filter((entry) => entry.Variables.error !== undefined);
// the log replaces a logged Error with its serialized record, the cause chain folded into `stack`
const loggedError = (entry: ILogEntry): ISerializedError => {
  const error: unknown = entry.Variables.error;
  if (typeof error !== 'object' || error === null || !('message' in error) || typeof error.message !== 'string') {
    throw new Error(`not a serialized error: ${inspect(error)}`);
  }
  return { name: 'name' in error ? String(error.name) : '', message: error.message, stack: 'stack' in error ? String(error.stack) : undefined };
};
const failedMessages = (run: RenderCase) => run.progress.filter((progress) => progress.phase === RenderPhase.Failed).map((progress) => progress.message);

describe('PuppeteerRenderer render errors', function () {
  this.timeout(60000);

  let sandbox: string;
  let refusedPort: number;
  let emptyPort: number;
  let emptyServer: Server;
  let silentPort: number;
  let silentServer: Server;
  const runs = new Map<string, RenderCase>();
  const runOf = (name: string): RenderCase => {
    const run = runs.get(name);
    if (run === undefined) throw new Error(`no render case ${name}`);
    return run;
  };

  before(async () => {
    sandbox = fs.mkdtempSync(join(tmpdir(), 'spinajs-puppeteer-render-error-'));

    const closed = createServer();
    refusedPort = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    // drops every connection: Chromium reports net::ERR_EMPTY_RESPONSE
    emptyServer = createServer((request) => request.socket.destroy());
    emptyPort = await listen(emptyServer);
    silentServer = createServer(() => undefined);
    silentPort = await listen(silentServer);

    DI.clearCache();
    DI.register(RenderErrorTestConf).as(Configuration);
    await DI.resolve(Configuration);
    const renderer = await DI.resolve(NavigatingRenderer);

    const urls = {
      refused: `http://127.0.0.1:${refusedPort}/doc/${SIGNED_PATH_SEGMENT}?X-Amz-Signature=${REFUSED_TOKEN}`,
      userinfo: `http://${USER}:${PASSWORD}@127.0.0.1:${refusedPort}/doc`,
      empty: `http://127.0.0.1:${emptyPort}/report/${SIGNED_PATH_SEGMENT}?token=${EMPTY_TOKEN}`,
      wrapped: `http://127.0.0.1:${refusedPort}/report?token=${WRAPPED_TOKEN}`,
      text: `http://127.0.0.1:${refusedPort}/text?token=${TEXT_TOKEN}`,
      timeout: `http://127.0.0.1:${silentPort}/slow?token=${TIMEOUT_TOKEN}`,
    };

    for (const [name, url] of Object.entries(urls)) {
      const run: RenderCase = { url, entries: [], progress: [], rejected: undefined };
      const rethrow = name === 'wrapped' ? 'wrapped' : name === 'text' ? 'as text' : 'as is';
      captured.length = 0;
      try {
        await renderer.renderUrlToFile(url, join(sandbox, `${name}.render-error-test`), (progress) => run.progress.push(progress), rethrow, name === 'timeout' ? 2000 : undefined);
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
    await new Promise<void>((resolve) => emptyServer.close(() => resolve()));
    silentServer.closeAllConnections();
    await new Promise<void>((resolve) => silentServer.close(() => resolve()));
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
