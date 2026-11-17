import 'mocha';
import { expect } from 'chai';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STUDIO_CSP, appBase, assetFile, locateUi, uiSegments, withStudioBase } from '../src/ui/ui.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

const INDEX = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Studio</title><script type="module" src="./assets/app-3f9a1c.js"></script></head><body><div id="root"></div></body></html>';
const SECRET = 'TOP-SECRET-OUTSIDE-DIST';

interface Fixture {
  readonly parent: string;
  readonly dist: string;
}

/** A dist/ as the UI package would ship it, beside a secret file and a directory that dist/ links to. */
function fixtureDist(): Fixture {
  const parent = mkdtempSync(join(tmpdir(), 'studio-ui-'));
  const dist = join(parent, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'assets', 'app-3f9a1c.js'), 'export {};');
  writeFileSync(join(dist, 'assets', 'app-3f9a1c.css'), 'body{}');
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dist, '.env'), SECRET);
  writeFileSync(join(dist, 'server.sh'), SECRET);
  writeFileSync(join(dist, '.secret-config.js'), SECRET);
  mkdirSync(join(dist, '.git'));
  writeFileSync(join(dist, '.git', 'config.json'), JSON.stringify({ secret: SECRET }));
  writeFileSync(join(parent, 'secret.txt'), SECRET);
  mkdirSync(join(parent, 'outside'));
  writeFileSync(join(parent, 'outside', 'secret.txt'), SECRET);
  // A junction needs no privilege on Windows; elsewhere the type is ignored and a directory symlink is made.
  symlinkSync(join(parent, 'outside'), join(dist, 'linked'), 'junction');
  return { parent, dist };
}

/**
 * The Windows 8.3 short names of `dist/.secret-config.js` and `dist/.git/config.json`, or undefined where the volume
 * makes none: the guess is kept only when the native real path expands it back to the long name.
 */
function shortNames(dist: string): string[] | undefined {
  const names: Array<[string, string]> = [
    ['SECRET~1.JS', '.secret-config.js'],
    ['GIT~1/config.json', join('.git', 'config.json')],
  ];
  const expands = ([short, long]: [string, string]) => existsSync(join(dist, short)) && realpathSync.native(join(dist, short)) === realpathSync.native(join(dist, long));
  return process.platform === 'win32' && names.every(expands) ? names.map(([short]) => short) : undefined;
}

interface RawReply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

/** Sends the path as written: an HTTP client would normalise its dot segments and escapes first. */
function raw(port: number, path: string, user = 'bob'): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { 'x-user': user, accept: 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('withStudioBase', () => {
  it('puts the base first in head, then the two metas, escaping both paths', () => {
    const html = withStudioBase(INDEX, '/a"b', '/x"y');
    expect(html).to.include('<head><base href="/a&quot;b/"><meta name="spina-studio-base" content="/a&quot;b"><meta name="spina-app-base" content="/x&quot;y"><meta charset');
  });

  it('gives the app base as the global route prefix: empty without one, else a leading slash and no trailing one', () => {
    expect([appBase(undefined), appBase(''), appBase('api'), appBase('api/'), appBase('v1/api')]).to.deep.eq(['', '', '/api', '/api', '/v1/api']);
  });

  it('injects into <head>, not into a <header> before it', () => {
    expect(withStudioBase('<html><header></header><head></head></html>', '/s', '')).to.eq('<html><header></header><head><base href="/s/"><meta name="spina-studio-base" content="/s"><meta name="spina-app-base" content=""></head></html>');
  });
});

describe('uiSegments and assetFile', () => {
  let fixture: Fixture;
  before(() => (fixture = fixtureDist()));
  after(() => rmSync(fixture.parent, { recursive: true, force: true }));

  it('decodes each segment and drops empty ones', () => {
    expect(uiSegments('assets/app%2D3f9a1c.js')).to.deep.eq(['assets', 'app-3f9a1c.js']);
    expect(uiSegments('traces//abc/')).to.deep.eq(['traces', 'abc']);
  });

  it('refuses dot segments, hidden names, separators and NUL bytes, raw or encoded, and a malformed escape', () => {
    const refused = ['..', '../x', 'a/../b', '%2e%2e/x', '%2E%2e', '.', '.env', 'assets/.x', '..%2fx', 'a%2fb', 'a%2Fb', '..%5cx', 'a%5cb', 'a\\b', '%2fetc%2fpasswd', 'x%00.js', '%E0%A4%A'];
    expect(refused.filter((path) => uiSegments(path) !== undefined)).to.deep.eq([]);
  });

  it('finds an existing file of an allowed type inside dist only', () => {
    const refused = ['../secret.txt', 'assets/../../secret.txt', '.env', 'a\\..\\secret.txt', 'x\0.js', join(fixture.parent, 'secret.txt')];
    expect(refused.map((path) => assetFile(fixture.dist, path))).to.deep.eq(refused.map(() => null));
    expect(assetFile(fixture.dist, 'assets/app-3f9a1c.js')).to.be.a('string');
    expect(assetFile(fixture.dist, 'missing.js')).to.eq(undefined);
    expect(assetFile(fixture.dist, 'assets')).to.eq(undefined);
  });

  it('refuses a file that a link inside dist leads outside of it, and a file type off the list', () => {
    // Found on disk, so answered like a missing file: a 404 here would tell the caller the file exists.
    expect(assetFile(fixture.dist, 'linked/secret.txt')).to.eq(undefined);
    expect(assetFile(fixture.dist, 'server.sh')).to.eq(undefined);
  });
});

describe('locateUi and assetFile where the native real path fails', () => {
  let fixture: Fixture;
  const native = realpathSync.native;
  before(() => {
    fixture = fixtureDist();
    // Node documents that the native call fails on some virtual and RAM drives where the JS one works.
    realpathSync.native = () => {
      throw Object.assign(new Error('EISDIR: native realpath unsupported'), { code: 'EISDIR' });
    };
  });
  after(() => {
    realpathSync.native = native;
    rmSync(fixture.parent, { recursive: true, force: true });
  });

  it('falls back to the JS real path', () => {
    const root = locateUi(fixture.dist);
    expect(root).to.eq(realpathSync(fixture.dist));
    expect(assetFile(root ?? '', 'assets/app-3f9a1c.js')).to.eq(realpathSync(join(fixture.dist, 'assets', 'app-3f9a1c.js')));
    expect(assetFile(root ?? '', 'linked/secret.txt')).to.eq(undefined);
  });
});

describe('Studio UI serving', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregister: () => void;
  let fixture: Fixture;
  const get = (path: string, user = 'bob') => app.request().get(path).set('x-user', user);

  before(async () => {
    unregister = registerHeaderSource();
    fixture = fixtureDist();
    app = await startApp({ config: { 'studio.ui.path': fixture.dist } });
  });

  after(async () => {
    await stopApp();
    rmSync(fixture.parent, { recursive: true, force: true });
    unregister();
  });

  it('serves index.html with the base, the meta, the CSP and no-store', async () => {
    const res = await get('/_studio/');
    expect(res.status).to.eq(200);
    expect(res.get('content-type')).to.match(/text\/html/);
    expect(res.text).to.include('<head><base href="/_studio/"><meta name="spina-studio-base" content="/_studio"><meta name="spina-app-base" content="">');
    expect(res.get('content-security-policy')).to.eq(STUDIO_CSP);
    expect(res.get('cache-control')).to.eq('no-store');
    expect(res.get('x-content-type-options')).to.eq('nosniff');
    expect((await get('/_studio/index.html')).text).to.include('spina-studio-base');
  });

  it('falls back to index.html for a deep link, never for an API path', async () => {
    const deep = await get('/_studio/traces/abc');
    expect(deep.text).to.include('spina-studio-base');
    expect(deep.get('cache-control')).to.eq('no-store');
    for (const path of ['/_studio/api/nope', '/_studio/api', '/_studio/api/authz/explain']) {
      const api = await get(path);
      expect(api.status, path).to.eq(404);
      expect(api.text, path).to.not.include('spina-studio-base');
    }
    expect((await get('/_studio/api/capabilities')).status).to.eq(200);
  });

  it('serves hashed assets as immutable and other files as no-cache, typed from the allowlist', async () => {
    const js = await get('/_studio/assets/app-3f9a1c.js');
    expect(js.status).to.eq(200);
    expect(js.get('content-type')).to.eq('text/javascript; charset=utf-8');
    expect(js.get('cache-control')).to.eq('private, max-age=31536000, immutable');
    expect(js.get('x-content-type-options')).to.eq('nosniff');
    expect((await get('/_studio/assets/app-3f9a1c.css')).get('content-type')).to.eq('text/css; charset=utf-8');
    const svg = await get('/_studio/favicon.svg');
    expect(svg.get('cache-control')).to.eq('no-cache');
    expect(svg.get('content-type')).to.eq('image/svg+xml');
    expect(svg.get('content-security-policy')).to.eq(STUDIO_CSP);
  });

  it('never serves a file outside dist, and refuses a malformed escape', async () => {
    expect((await get('/_studio/assets/%2e%2e/%2e%2e/package.json')).text).to.not.include('"name"');
    // Express fails to decode the path parameter before the controller runs; the controller has its own guard.
    expect((await get('/_studio/assets/%E0%A4%A')).status).to.not.eq(200);
  });

  it('answers 404 without the install hint to every path that could leave dist, sent unnormalised', async () => {
    const paths = [
      '/_studio/../secret.txt',
      '/_studio/assets/../../secret.txt',
      '/_studio/%2e%2e/secret.txt',
      '/_studio/%2E%2E/%2e%2e/secret.txt',
      '/_studio/..%2fsecret.txt',
      '/_studio/..%2Fsecret.txt',
      '/_studio/..%5csecret.txt',
      '/_studio/..\\secret.txt',
      '/_studio/%2f..%2fsecret.txt',
      `/_studio/${encodeURIComponent(join(fixture.parent, 'secret.txt'))}`,
      '/_studio/assets/app-3f9a1c.js%00.html',
      '/_studio/.env',
      '/_studio/assets/.%2e/.%2e/secret.txt',
    ];
    for (const path of paths) {
      const res = await raw(app.port, path);
      expect(res.status, path).to.eq(404);
      expect(res.text, path).to.not.include(SECRET);
      expect(res.text, path).to.not.include('spina-studio-base');
      expect(res.text, path).to.not.include('@spinajs/studio-ui');
    }
  });

  it('answers a file it refuses after finding it exactly like a missing one', async () => {
    for (const [refused, missing] of [
      ['/_studio/server.sh', '/_studio/nope.sh'],
      ['/_studio/linked/secret.txt', '/_studio/linked/nope.txt'],
    ]) {
      const [a, b] = [await raw(app.port, refused), await raw(app.port, missing)];
      expect([a.status, a.text], refused).to.deep.eq([b.status, b.text]);
      expect(a.text, refused).to.not.include(SECRET);
    }
  });

  it('never serves a hidden file of dist through its Windows 8.3 short name', async function () {
    // Short names exist on Windows only, and only on a volume that makes them.
    const names = shortNames(fixture.dist);
    if (!names) this.skip();
    for (const name of names) {
      const res = await raw(app.port, `/_studio/${name}`);
      expect(res.text, name).to.not.include(SECRET);
      expect(res.text, name).to.include('spina-studio-base');
    }
  });

  it('serves index.html with the base for any spelling the file system resolves to it', async function () {
    // A case-sensitive file system has no INDEX.HTML.
    if (!existsSync(join(fixture.dist, 'INDEX.HTML'))) this.skip();
    const res = await raw(app.port, '/_studio/INDEX.HTML');
    expect(res.text).to.include('<base href="/_studio/">');
    expect(res.headers['cache-control']).to.eq('no-store');
  });

  it('checks the ui slot: 401 without a caller, 403 without studio:read, on files, deep links and API paths alike', async () => {
    expect((await get('/_studio/', 'alice')).status).to.eq(403);
    expect((await get('/_studio/assets/app-3f9a1c.js', 'alice')).status).to.eq(403);
    for (const path of ['/_studio/', '/_studio/assets/app-3f9a1c.js', '/_studio/traces/abc', '/_studio/api/nope', '/_studio/api/capabilities']) {
      expect((await app.request().get(path)).status, path).to.eq(401);
    }
  });
});

describe('Studio UI under http.controllers.route.prefix', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregister: () => void;
  let fixture: Fixture;
  const get = (path: string) => app.request().get(path).set('x-user', 'bob');

  before(async () => {
    unregister = registerHeaderSource();
    fixture = fixtureDist();
    app = await startApp({ config: { 'studio.ui.path': fixture.dist, 'http.controllers.route.prefix': 'api' } });
  });

  after(async () => {
    await stopApp();
    rmSync(fixture.parent, { recursive: true, force: true });
    unregister();
  });

  it('writes the prefixed Studio base and the app base into index.html, and serves assets under the prefix', async () => {
    const res = await get('/api/_studio/');
    expect(res.status).to.eq(200);
    expect(res.text).to.include('<head><base href="/api/_studio/"><meta name="spina-studio-base" content="/api/_studio"><meta name="spina-app-base" content="/api">');
    expect(res.get('content-security-policy')).to.eq(STUDIO_CSP);
    expect((await get('/api/_studio/assets/app-3f9a1c.js')).status).to.eq(200);
    expect((await get('/api/_studio/api/capabilities')).status).to.eq(200);
    expect((await get('/api/_studio/api/nope')).text).to.not.include('spina-studio-base');
    expect((await get('/_studio/')).status).to.eq(404);
  });
});

describe('Studio UI missing', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregister: () => void;

  before(async () => {
    unregister = registerHeaderSource();
    app = await startApp({ config: { 'studio.ui.path': join(tmpdir(), 'no-such-studio-ui') } });
  });

  after(async () => {
    await stopApp();
    unregister();
  });

  it('answers 404 naming the package and the registry, while the API still works', async () => {
    const res = await app.request().get('/_studio/').set('x-user', 'bob').set('Accept', 'application/json');
    expect(res.status).to.eq(404);
    expect(res.text).to.include('@spinajs/studio-ui').and.to.include('studio.ui.path');
    expect((await app.request().get('/_studio/api/capabilities').set('x-user', 'bob')).status).to.eq(200);
  });
});

describe('Studio UI while Studio is not mounted', function () {
  this.timeout(30000);

  let unregister: () => void;
  let fixture: Fixture;

  before(() => {
    unregister = registerHeaderSource();
    fixture = fixtureDist();
  });

  after(() => {
    rmSync(fixture.parent, { recursive: true, force: true });
    unregister();
  });

  afterEach(() => stopApp());

  for (const [name, config] of [
    ['disabled', { 'studio.enabled': false }],
    ['in production without studio.allowProduction', { 'configuration.isProduction': true }],
  ] as const) {
    it(`serves no file while Studio is ${name}`, async () => {
      const app = await startApp({ config: { ...config, 'studio.ui.path': fixture.dist } });
      for (const path of ['/_studio/', '/_studio/assets/app-3f9a1c.js']) {
        const res = await app.request().get(path).set('x-user', 'bob');
        expect(res.status, path).to.eq(404);
        expect(res.text, path).to.not.include('export {}');
        expect(res.text, path).to.not.include('spina-studio-base');
      }
    });
  }
});
