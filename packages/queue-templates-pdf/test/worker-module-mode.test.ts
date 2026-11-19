import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { join, normalize, resolve as resolvePath } from 'path';
import * as fs from 'fs';
import * as chai from 'chai';
import { IRenderRequest, WorkerMessage } from '../src/protocol.js';

const expect = chai.expect;

const esmEntry = fileURLToPath(new URL('../src/render-worker.ts', import.meta.url));
const commonJsEntry = fileURLToPath(new URL('../lib/cjs/render-worker.js', import.meta.url));

function dir(path: string) {
  return resolvePath(normalize(join(process.cwd(), 'test', path)));
}

type TerminalMessage = Exclude<WorkerMessage, { type: 'progress' }>;

/** Forks the worker entry as RenderPdfJob does; the child starts without the parent's DI state. */
function renderInWorker(entry: string, execArgv: string[], req: IRenderRequest): Promise<{ message: TerminalMessage; output: string }> {
  return new Promise((resolve, reject) => {
    const child = fork(entry, [], { silent: true, execArgv });
    let output = '';
    child.stdout?.on('data', (d) => (output += String(d)));
    child.stderr?.on('data', (d) => (output += String(d)));

    let message: TerminalMessage | undefined;
    child.on('message', (m: WorkerMessage) => {
      if (m.type !== 'progress') {
        message = m;
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => (message ? resolve({ message, output }) : reject(new Error(`worker exited with code ${code} without an answer:\n${output}`))));

    child.send(req);
  });
}

function request(path: string): IRenderRequest {
  return {
    input: '<!doctype html><html><body><h1>hello</h1></body></html>',
    output: { provider: 'out', path },
    config: {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      fs: {
        defaultProvider: 'out',
        providers: [{ service: 'fsNative', name: 'out', basePath: dir('output') }],
      },
      templates: {
        pdf: {
          args: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          },
        },
      },
    },
  };
}

describe('the forked render worker boots its configuration', function () {
  this.timeout(180000);

  const outputs: string[] = [];

  before(() => fs.mkdirSync(dir('output'), { recursive: true }));
  after(() => outputs.forEach((f) => fs.rmSync(f, { force: true })));

  it('in an ESM application, and renders the PDF', async () => {
    outputs.push(dir('output/worker-esm.pdf'));

    // The test process's ts-node loader, so the child runs the worker source as ESM.
    const { message, output } = await renderInWorker(esmEntry, process.execArgv, request('worker-esm.pdf'));

    expect(message, output).to.deep.equal({ type: 'done', result: { provider: 'out', path: 'worker-esm.pdf' } });
    expect(fs.readFileSync(dir('output/worker-esm.pdf')).subarray(0, 4).toString('ascii')).to.equal('%PDF');
  });

  it('in a CommonJS application, and renders the PDF', async function () {
    if (!fs.existsSync(commonJsEntry)) {
      this.skip();
    }
    outputs.push(dir('output/worker-cjs.pdf'));

    const { message, output } = await renderInWorker(commonJsEntry, [], request('worker-cjs.pdf'));

    expect(message, output).to.deep.equal({ type: 'done', result: { provider: 'out', path: 'worker-cjs.pdf' } });
    expect(fs.readFileSync(dir('output/worker-cjs.pdf')).subarray(0, 4).toString('ascii')).to.equal('%PDF');
  });
});
