import 'mocha';
import { expect } from 'chai';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Cli } from '../src/index.js';

const manifestPath = resolve(process.cwd(), '../compiler/test/fixtures/app-basic/app.manifest.json');

class GenerateConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: { dirs: { cli: [resolve(process.cwd(), 'src/cli')] } },
    };
  }
}

describe('generate:asyncapi', function () {
  this.timeout(60000);

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'asyncapi-'));
    DI.clearCache();
    DI.register(GenerateConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes an AsyncAPI 3.0 document for the manifest', async () => {
    const out = join(dir, 'asyncapi.json');
    DI.register(() => ['node', 'script.js', 'generate:asyncapi', '--manifest', manifestPath, '--out', out, '--doc-version', '2.0.0']).as('__cli_argv_provider__');

    await DI.resolve(Cli);

    const doc = JSON.parse(await readFile(out, 'utf8')) as { asyncapi: string; info: { title: string; version: string }; channels: Record<string, unknown> };
    expect(doc.asyncapi).to.equal('3.0.0');
    expect(doc.info).to.include({ title: 'app-basic', version: '2.0.0' });
    expect(doc.channels).to.have.property('socket/chat/send');
  });
});
