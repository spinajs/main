import 'mocha';
import { expect } from 'chai';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import type { Manifest } from '@spinajs/manifest';
import { Cli } from '../src/index.js';
import { ManifestDiff } from '../src/cli/ManifestDiff.js';

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

class Captured extends ManifestDiff {
  public output = '';
  protected override write(text: string): void {
    this.output += text;
  }
}

type Operation = { operationId: string; requestBody?: unknown; responses: Record<string, unknown> };

describe('generated documents carry routes a controller inherits', function () {
  this.timeout(60_000);

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inherited-'));
    DI.clearCache();
    DI.register(GenerateConf).as(Configuration);
    await DI.resolve(Configuration);
    process.exitCode = undefined;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('generate:openapi documents the inherited routes with the subclass types', async () => {
    const out = join(dir, 'openapi.json');
    DI.register(() => ['node', 'script.js', 'generate:openapi', '--manifest', manifestPath, '--out', out]).as('__cli_argv_provider__');
    await DI.resolve(Cli);
    const doc = JSON.parse(await readFile(out, 'utf8')) as { paths: Record<string, Record<string, Operation>> };
    expect(doc.paths['/articles/{id}'].get.operationId).to.equal('Articles_read');
    expect(JSON.stringify(doc.paths['/articles/{id}'].get.responses['200'])).to.include('#/components/schemas/ArticleDto');
    expect(JSON.stringify(doc.paths['/articles/add'].post.requestBody)).to.include('#/components/schemas/CreateArticleDto');
  });

  it('generate:client gives the subclass its inherited methods with its types', async () => {
    const out = join(dir, 'client.ts');
    DI.register(() => ['node', 'script.js', 'generate:client', '--manifest', manifestPath, '--out', out]).as('__cli_argv_provider__');
    await DI.resolve(Cli);
    const source = await readFile(out, 'utf8');
    expect(source).to.include('export interface ArticlesClient {\n  read(id: number): Promise<ArticleDto>;\n  add(body: CreateArticleDto): Promise<ArticleDto>;\n}');
    expect(source).to.include("read: { method: 'get', path: '/articles/{id}', args: [{ in: 'path', name: 'id', shape: 'value' }] },");
  });

  it('manifest:diff lists an inherited route a head manifest drops', async () => {
    const head = join(dir, 'head.json');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    m.controllers = m.controllers.map((c) => (c.className === 'ArticlesController' ? { ...c, routes: c.routes.filter((r) => r.handler !== 'add') } : c));
    m.hash = 'b'.repeat(64);
    writeFileSync(head, JSON.stringify(m));
    const cmd = new Captured();
    await cmd.execute(manifestPath, head, { format: 'markdown' });
    expect(cmd.output).to.include('`POST /articles/add`');
    expect(cmd.output).to.include('**BREAKING**');
  });
});
