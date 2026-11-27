import 'mocha';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { expect } from 'chai';
import { Configuration, FrameworkConfiguration, Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { ICommonTargetOptions, ILogEntry, LogTarget } from '@spinajs/log';
import { Page } from 'puppeteer';

import { PuppeteerRenderer, IPuppeteerRendererOptions } from '../src/index.js';

const SIGNED_PATH_SEGMENT = '0f8c2a4be1d94c3e9a7b5d6e8f901234';
const RESPONSE_TOKEN = 'planted-response-signature';
const FAILED_TOKEN = 'planted-failed-token';
const SCRIPT_TOKEN = 'planted-script-signature';
const IMPORT_TOKEN = 'planted-import-signature';
const USER = 'pl4nteduser';
const PASSWORD = 'planted-password';
const PLANTED = [SIGNED_PATH_SEGMENT, RESPONSE_TOKEN, FAILED_TOKEN, SCRIPT_TOKEN, IMPORT_TOKEN, USER, PASSWORD, 'planted'];

const captured: ILogEntry[] = [];

@Injectable('PuppeteerLogCapture')
export class CaptureTarget extends LogTarget<ICommonTargetOptions> {
  public write(entry: ILogEntry): void {
    captured.push(entry);
  }
}

@Injectable()
class LogTestRenderer extends PuppeteerRenderer {
  @Config('templates.puppeteerLogTest')
  protected Options: IPuppeteerRendererOptions;

  public get Type() {
    return 'puppeteer-log-test';
  }

  public get Extension() {
    return '.log-test';
  }

  protected async performRender(_page: Page, _filePath: string): Promise<void> {}
}

class LogTestConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Capture', type: 'PuppeteerLogCapture' }],
        rules: [{ name: '*', level: 'trace', target: 'Capture' }],
      },
      templates: {
        puppeteerLogTest: {
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

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the probe server is not listening on a TCP port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

const fieldsOf = (entry: ILogEntry): Record<string, unknown> => entry.Variables;
const everything = (): string => inspect(captured, { depth: 20, showHidden: true, breakLength: Infinity });

describe('PuppeteerRenderer page logs', function () {
  this.timeout(60000);

  let sandbox: string;
  let refusedPort: number;

  before(async () => {
    sandbox = fs.mkdtempSync(join(tmpdir(), 'spinajs-puppeteer-log-'));
    fs.mkdirSync(join(sandbox, 'signed', SIGNED_PATH_SEGMENT), { recursive: true });
    fs.writeFileSync(join(sandbox, 'signed', SIGNED_PATH_SEGMENT, 'theme.css'), 'body { margin: 0; }\n');
    fs.writeFileSync(join(sandbox, 'boom.js'), "throw new Error('boom from a signed script');\n");
    refusedPort = await closedPort();

    DI.clearCache();
    DI.register(LogTestConf).as(Configuration);
    await DI.resolve(Configuration);

    const html = [
      '<html><head></head><body>',
      `<link rel="stylesheet" href="signed/${SIGNED_PATH_SEGMENT}/theme.css?X-Amz-Signature=${RESPONSE_TOKEN}">`,
      `<img src="http://127.0.0.1:${refusedPort}/assets/photo.png?token=${FAILED_TOKEN}">`,
      `<script defer src="boom.js?X-Amz-Signature=${SCRIPT_TOKEN}"></script>`,
      `<img src="http://${USER}:${PASSWORD}@127.0.0.1:${refusedPort}/private/badge.png">`,
      `<script type="module">await import('./lazy-module.js?X-Amz-Signature=${IMPORT_TOKEN}');</script>`,
      '</body></html>',
    ].join('');

    const renderer = await DI.resolve(LogTestRenderer);
    await renderer.renderHtmlToFile(html, join(sandbox, 'out.log-test'), { assetBasePath: sandbox });
    await new Promise((resolve) => setImmediate(resolve));  });

  after(async () => {
    await DI.dispose();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('logs a response with the host, the port and the plain path segments of the asset', () => {
    const responses = captured.filter((entry) => fieldsOf(entry).status === 200 && String(fieldsOf(entry).url).includes('theme.css'));
    expect(responses.length, 'the signed stylesheet was answered').to.eq(1);
    expect(fieldsOf(responses[0]).url).to.match(/^http:\/\/127\.0\.0\.1:\d+\/signed\/\*\*\*\/theme\.css$/);
    expect(inspect(responses, { depth: 20 })).to.not.contain(RESPONSE_TOKEN).and.not.contain(SIGNED_PATH_SEGMENT);
  });

  it('logs a failed request with the error text and the asset without its query', () => {
    const failed = captured.filter((entry) => fieldsOf(entry).reason === 'net::ERR_CONNECTION_REFUSED');
    expect(failed.length, 'the refused photo was reported').to.eq(1);
    expect(fieldsOf(failed[0]).url).to.eq(`http://127.0.0.1:${refusedPort}/assets/photo.png`);
    expect(inspect(failed, { depth: 20 })).to.not.contain(FAILED_TOKEN);
  });

  it('logs a page error by its message without the URLs of the page', () => {
    const errors = captured.filter((entry) => inspect(entry, { depth: 20 }).includes('boom from a signed script'));
    expect(errors.length, 'the script error was reported').to.be.greaterThan(0);
    expect(inspect(errors, { depth: 20, showHidden: true })).to.not.contain(SCRIPT_TOKEN);
  });

  it('logs a failed module import without the URL it quotes', () => {
    const errors = captured.filter((entry) => inspect(entry, { depth: 20 }).includes('Failed to fetch dynamically imported module'));
    expect(errors.length, 'the failed import was reported').to.eq(1);
    expect(fieldsOf(errors[0]).reason).to.match(/^TypeError: Failed to fetch dynamically imported module: http:\/\/127\.0\.0\.1:\d+\/lazy-module\.js$/);
    expect(inspect(errors, { depth: 20, showHidden: true })).to.not.contain(IMPORT_TOKEN);
  });

  it('logs a request with credentials in its URL without them', () => {
    const failed = captured.filter((entry) => String(fieldsOf(entry).url).endsWith('/private/badge.png'));
    expect(failed.length, 'the badge was reported').to.eq(1);
    expect(fieldsOf(failed[0]).url).to.eq(`http://127.0.0.1:${refusedPort}/private/badge.png`);
    expect(inspect(failed, { depth: 20 })).to.not.contain(USER).and.not.contain(PASSWORD);
  });

  it('prints no part of a planted token at any level', () => {
    const text = everything();
    for (const planted of PLANTED) expect(text).to.not.contain(planted);
  });
});
