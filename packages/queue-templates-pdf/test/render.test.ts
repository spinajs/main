import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { join, normalize, resolve } from 'path';
import * as fs from 'fs';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { renderPdfToProvider } from '../src/render.js';
import { WorkerMessage } from '../src/protocol.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

class ConnectionConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '{datetime} {level} {message} {error} duration: {duration} ({logger})',
          },
        ],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      fs: {
        defaultProvider: 'out',
        providers: [
          {
            service: 'fsNative',
            name: 'out',
            basePath: dir('output'),
          },
        ],
      },
      templates: {
        pdf: {
          static: { portRange: [8080, 8090] },
          args: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          },
          renderDurationWarning: 60000,
          renderTimeout: 60000,
        },
      },
    };
  }
}

type ProgressMessage = Extract<WorkerMessage, { type: 'progress' }>;

describe('renderPdfToProvider (worker core)', function () {
  this.timeout(60000);

  const outputs: string[] = [];

  beforeEach(async () => {
    DI.clearCache();
    fs.mkdirSync(dir('output'), { recursive: true });
    // only register config; renderPdfToProvider bootstraps DI/fs itself
    DI.register(ConnectionConf).as(Configuration);
  });

  afterEach(async () => {
    for (const f of outputs.splice(0)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    // dispose so the pooled browser is closed and the process can exit
    await DI.dispose();
  });

  it('renders raw HTML to a PDF, uploads it to the fs provider, and reports progress', async () => {
    const outFile = dir('output/result.pdf');
    outputs.push(outFile);

    const events: ProgressMessage[] = [];
    // three local images -> real requests, so resource-driven progress is exercised
    const html =
      '<!doctype html><html><head></head><body>' +
      '<img src="img.png?i=1"><img src="img.png?i=2"><img src="img.png?i=3">' +
      '</body></html>';

    const result = await renderPdfToProvider(
      {
        input: html,
        output: { provider: 'out', path: 'result.pdf' },
        assetBasePath: dir('assets'),
      },
      (m) => events.push(m),
    );

    // returned descriptor
    expect(result).to.deep.eq({ provider: 'out', path: 'result.pdf' });

    // the PDF was uploaded to the provider's base path
    expect(fs.existsSync(outFile), 'output PDF exists in provider base').to.eq(true);
    expect(fs.readFileSync(outFile).subarray(0, 4).toString('ascii')).to.eq('%PDF');

    // progress was reported: phases advanced, resources tracked, ended complete
    expect(events.length).to.be.greaterThan(0);
    expect(events.some((e) => e.phase === 'loading')).to.eq(true);
    const last = events[events.length - 1];
    expect(last.percent).to.eq(100);
    expect(last.phase).to.eq('done');
  });
});
