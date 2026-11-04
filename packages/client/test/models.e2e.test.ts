import 'mocha';
import { expect } from 'chai';
import ts from 'typescript';
import { DateTime } from 'luxon';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AccessPolicy, PrincipalMiddleware } from '@spinajs/authz-http';
import { analyzePackage } from '@spinajs/compiler';
import { DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { MANIFEST, MANIFEST_SETTINGS } from '@spinajs/configuration';
import { BaseController, ControllerSource, Controllers, FilesystemControllerSource, HttpServer, ServerMiddleware } from '@spinajs/http';
import { Intl } from '@spinajs/intl';
import { hashManifest, type Manifest } from '@spinajs/manifest';
import { createTestApp, testManifest } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { generateClientFiles } from '../src/index.js';
import { dateCodec, fromClass, type Codec, type ProblemError } from '../src/runtime/index.js';
import { ArticlesController, received, SAMPLE } from './fixtures/models-app/src/controllers.js';
import { AllowAccess, E2eConfiguration } from './support/harness.js';
import { typecheck } from './support/typecheck.js';

const app = fileURLToPath(new URL('./fixtures/models-app', import.meta.url));
const runtimeUrl = pathToFileURL(fileURLToPath(new URL('../lib/runtime/index.js', import.meta.url))).href;

/** A decimal whose JSON form is exponent text, which the server's strict `decimal` format rejects. */
class Dec {
  constructor(public readonly text: string) {}
  public toFixed(): string {
    return this.text;
  }
  public toJSON(): string {
    return Number(this.text).toExponential();
  }
}

const decimalCodec: Codec<Dec> = { decode: (wire) => new Dec(wire as string), encode: (value) => value.toFixed() };
const bigintCodec: Codec<bigint> = { decode: (wire) => BigInt(wire as string), encode: (value) => value.toString() };
const luxonCodec: Codec<DateTime> = { decode: (wire) => DateTime.fromISO(wire as string, { zone: 'utc' }), encode: (value) => value.toUTC().toISO() };

class Author {
  public id = 0;
  public name = '';
  public joinedAt!: Date;
  public cache: unknown = undefined;
  public get initial(): string {
    return this.name.slice(0, 1);
  }
}

class Circle {
  public kind!: 'circle';
  public radius = 0;
  public drawnAt!: Date;
}

class Article {
  public id = 0;
  public title = '';
  public publishedAt!: Date;
  public reviewedAt!: Date;
  public total!: Dec;
  public views!: bigint;
  public author!: Author;
  public lines!: { sku: string; price: Dec; tax?: Dec }[];
  public shape!: Circle | { kind: 'square'; side: number };
  public audit!: { at: Date; by: string };
  public closedAt?: Date | null;
  public local = 'never sent';
  public get isFresh(): boolean {
    return this.publishedAt.getTime() > Date.parse('2026-01-01T00:00:00Z');
  }
}

interface ArticleApi<A, D> {
  get(id: number): Promise<A>;
  save(article: A): Promise<A>;
  since(from: D): Promise<A[]>;
  on(day: D): Promise<A[]>;
}

type Api<A = Article, D = Date> = { articles: ArticleApi<A, D> };
type CreateApp = (options: Record<string, unknown>) => unknown;

async function manifest(): Promise<Manifest> {
  const fragment = await analyzePackage({ tsconfig: `${app}/tsconfig.json`, packageRoot: app });
  return testManifest({ app: { name: 'models-app', version: '0.1.0', root: app, outDir: 'src' }, controllers: fragment.controllers, schemas: fragment.schemas });
}

/** Boots with the manifest on, so the server validates request arguments against the schemas derived from the DTO types. */
async function bootWithManifest(source: Manifest, dir: string): Promise<TestApp> {
  const file = join(dir, 'app.manifest.json');
  writeFileSync(file, JSON.stringify({ ...source, hash: hashManifest(source) }));
  const saved = { SPINAJS_MANIFEST: process.env.SPINAJS_MANIFEST, SPINAJS_MANIFEST_MODE: process.env.SPINAJS_MANIFEST_MODE };
  process.env.SPINAJS_MANIFEST = file;
  process.env.SPINAJS_MANIFEST_MODE = 'require';
  try {
    return await createTestApp({
      configuration: E2eConfiguration,
      register: (c) => {
        c.unregister(ServerMiddleware, PrincipalMiddleware);
        c.unregister(ControllerSource, FilesystemControllerSource);
        c.register(ArticlesController).as(BaseController);
        c.register(AllowAccess).as(AccessPolicy);
      },
      resolve: [fsService, Intl, Controllers],
      bootTimeout: 50000,
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Transpiles the generated client and imports it against the built runtime. */
async function load(source: string): Promise<CreateApp> {
  const js = ts.transpileModule(source.replace('@spinajs/client/runtime', runtimeUrl), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dir = mkdtempSync(join(tmpdir(), 'client-models-e2e-'));
  try {
    const file = join(dir, 'client.mjs');
    writeFileSync(file, js);
    return ((await import(pathToFileURL(file).href)) as { createAppClient: CreateApp }).createAppClient;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('generated model client against a booted server', function () {
  this.timeout(60000);

  let testApp: TestApp;
  let baseUrl: string;
  let generated: string;
  let createAppClient: CreateApp;
  const manifestDir = mkdtempSync(join(tmpdir(), 'models-e2e-manifest-'));

  const models = { ArticleDto: fromClass(Article), AuthorDto: fromClass(Author), CircleDto: fromClass(Circle) };
  const formats = { 'date-time': dateCodec, decimal: decimalCodec, int64: bigintCodec };
  const client = (options: Record<string, unknown>) => createAppClient({ baseUrl, ...options }) as Api;

  const post = (body: unknown) => fetch(`${baseUrl}/articles/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    const source = await manifest();
    generated = (await generateClientFiles({ manifest: source, models: true }))[0].contents;
    createAppClient = await load(generated);
    testApp = await bootWithManifest(source, manifestDir);
    const server = await testApp.resolve(HttpServer);
    await server.start();
    const { port } = DI.get(HttpServer)!.Server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await testApp.dispose();
    rmSync(manifestDir, { recursive: true, force: true });
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  describe('the fixture', () => {
    it('answers a request that carries a field the schema does not declare with 400', async () => {
      expect((await post(SAMPLE)).status).to.equal(200);
      expect((await post({ ...SAMPLE, extra: 1 })).status).to.equal(200);
      expect((await post({ ...SAMPLE, author: { ...SAMPLE.author, extra: 1 } })).status).to.equal(400);
      expect((await post({ ...SAMPLE, audit: { ...SAMPLE.audit, extra: 1 } })).status).to.equal(400);
      expect((await post({ ...SAMPLE, shape: { ...SAMPLE.shape, extra: 1 } })).status).to.equal(400);
    });

    it('validates the formats the generator maps', async () => {
      expect((await post({ ...SAMPLE, total: '1.25e+1' })).status).to.equal(400);
      expect((await post({ ...SAMPLE, views: '1.5' })).status).to.equal(400);
      expect((await post({ ...SAMPLE, publishedAt: 'yesterday' })).status).to.equal(400);
    });
  });

  describe('decode', () => {
    let article: Article;

    before(async () => {
      article = await client({ formats, models }).articles.get(1);
    });

    it('turns the reply into the registered class, with its getters and no extra state', () => {
      expect(article).to.be.instanceOf(Article);
      expect(article.isFresh).to.equal(true);
      expect(article.local).to.equal('never sent');
      expect(article.author).to.be.instanceOf(Author);
      expect(article.author.initial).to.equal('A');
    });

    it('decodes every codec type, nested and in arrays', () => {
      expect(article.publishedAt).to.be.instanceOf(Date);
      expect(article.publishedAt.toISOString()).to.equal(SAMPLE.publishedAt);
      expect(article.reviewedAt).to.be.instanceOf(Date);
      expect(article.author.joinedAt).to.be.instanceOf(Date);
      expect(article.audit.at.toISOString()).to.equal(SAMPLE.audit.at);
      expect(article.total).to.be.instanceOf(Dec);
      expect(article.total.text).to.equal('12.50');
      expect(article.lines.map((line) => line.price instanceof Dec)).to.deep.equal([true, true]);
      expect(article.lines[0].tax).to.be.instanceOf(Dec);
      expect(article.lines[1]).to.not.have.property('tax');
      expect(article.views).to.equal(9007199254740993n);
    });

    it('picks the union member by its discriminator and leaves null alone', () => {
      expect(article.shape).to.be.instanceOf(Circle);
      expect((article.shape as Circle).drawnAt).to.be.instanceOf(Date);
      expect(article.closedAt).to.equal(null);
    });

    it('keeps the wire text in every slot without a codec', async () => {
      const plain = await client({ formats: { 'date-time': dateCodec } }).articles.get(1);
      expect(plain).to.not.be.instanceOf(Article);
      expect(plain.publishedAt).to.be.instanceOf(Date);
      expect(plain.total).to.equal('12.50');
      expect(plain.views).to.equal('9007199254740993');
    });
  });

  describe('encode', () => {
    it('sends back what it decoded and the server accepts it', async () => {
      const api = client({ formats, models });
      const article = await api.articles.get(1);
      const echoed = await api.articles.save(article);
      expect(received.save[0]).to.deep.equal(SAMPLE);
      expect(echoed).to.be.instanceOf(Article);
      expect(echoed.publishedAt.getTime()).to.equal(article.publishedAt.getTime());
      expect(echoed.total.text).to.equal('12.50');
    });

    it('writes a decimal with toFixed(), not with its exponent JSON form', async () => {
      const api = client({ formats, models });
      const article = await api.articles.get(1);
      expect(JSON.stringify(article.total)).to.equal('"1.25e+1"');
      await api.articles.save(article);
      expect((received.save[0] as { total: string }).total).to.equal('12.50');
    });

    it('is rejected with 400 when the decimal codec encodes the exponent form', async () => {
      const api = client({ formats: { ...formats, decimal: { ...decimalCodec, encode: (value: Dec) => value.toJSON() } }, models });
      const article = await api.articles.get(1);
      const error = await api.articles.save(article).catch((e: unknown) => e);
      expect((error as ProblemError).status).to.equal(400);
    });

    it('drops fields and accessors a class adds, at every nesting level', async () => {
      const api = client({ formats, models });
      const article = await api.articles.get(1);
      article.local = 'x';
      article.author.cache = { hot: true };
      Object.defineProperty(article, 'badge', { get: () => 'new', enumerable: true });
      Object.defineProperty(article.author, 'label', { get: () => 'Ada', enumerable: true });
      Object.assign(article.audit, { note: 'local' });
      Object.assign(article.shape, { selected: true });
      Object.assign(article.lines[0], { dirty: true });
      expect(Object.keys(article)).to.include.members(['local', 'badge']);
      expect(Object.keys(article.shape)).to.include('selected');
      await api.articles.save(article);
      expect(received.save[0]).to.deep.equal(SAMPLE);
    });

    it('is what protects the request: a client without formats and models sends the extra field and gets 400', async () => {
      const api = client({});
      const article = await api.articles.get(1);
      Object.assign(article.author, { cache: { hot: true } });
      const error = await api.articles.save(article).catch((e: unknown) => e);
      expect((error as ProblemError).status).to.equal(400);
    });
  });

  describe('query and path arguments', () => {
    it('send a Date as ISO text', async () => {
      const api = client({ formats, models });
      const at = new Date('2026-05-06T07:08:09.000Z');
      expect((await api.articles.since(at)).map((a) => a instanceof Article)).to.deep.equal([true]);
      expect(received.since).to.deep.equal([at.toISOString()]);
      await api.articles.on(at);
      expect(received.on).to.deep.equal([at.toISOString()]);
    });
  });

  describe('a luxon codec', () => {
    it('decodes DateTime values, encodes them back and the server accepts them', async () => {
      const api = client({ formats: { 'date-time': luxonCodec } }) as unknown as Api<Record<string, never>, DateTime>;
      const article = (await api.articles.get(1)) as unknown as { publishedAt: DateTime; author: { joinedAt: DateTime }; shape: { drawnAt: DateTime } };
      expect(article.publishedAt).to.be.instanceOf(DateTime);
      expect(article.publishedAt.toISO()).to.equal(SAMPLE.publishedAt);
      expect(article.author.joinedAt.year).to.equal(2025);
      expect(article.shape.drawnAt).to.be.instanceOf(DateTime);
      await api.articles.save(article as never);
      expect(received.save[0]).to.deep.equal(SAMPLE);
      await api.articles.since(DateTime.fromISO('2026-05-06T07:08:09.000Z', { zone: 'utc' }));
      expect(received.since).to.deep.equal(['2026-05-06T07:08:09.000Z']);
    });
  });

  describe('types', () => {
    it('type-checks app classes merged with the generated model interfaces', () => {
      const diagnostics = typecheck(
        [
          generated,
          `import { dateCodec, fromClass, type Codec, type ModelEntry } from '@spinajs/client/runtime';`,
          `declare const decimalCodec: Codec<{ toFixed(): string }>;`,
          `declare const bigintCodec: Codec<bigint>;`,
          `const formats = { 'date-time': dateCodec, decimal: decimalCodec, int64: bigintCodec } as const;`,
          `type AppFormats = FormatTypes<typeof formats>;`,
          `type AppModels = { ArticleDto: ModelEntry<Article>; AuthorDto: ModelEntry<Author> };`,
          `export interface Author extends AuthorDtoModel<AppFormats, AppModels> {}`,
          `export class Author { cache?: unknown; get initial(): string { return this.name.slice(0, 1); } }`,
          `export interface Article extends ArticleDtoModel<AppFormats, AppModels> {}`,
          `export class Article { get isFresh(): boolean { return this.publishedAt.getTime() > 0; } }`,
          `const api = createAppClient({ baseUrl: '/', formats, models: { ArticleDto: fromClass(Article), AuthorDto: fromClass(Author) } });`,
          `export async function check(): Promise<void> {`,
          `  const article: Article = await api.articles.get(1);`,
          `  const published: Date = article.publishedAt;`,
          `  const views: bigint = article.views;`,
          `  const total: string = article.total.toFixed();`,
          `  const author: Author = article.author;`,
          `  const joined: Date = author.joinedAt;`,
          `  const list: Article[] = await api.articles.since(new Date());`,
          `  await api.articles.save(article);`,
          `  void [published, views, total, joined, list];`,
          `}`,
        ].join('\n'),
        { unused: true },
      );
      expect(diagnostics).to.deep.equal([]);
    });
  });
});
