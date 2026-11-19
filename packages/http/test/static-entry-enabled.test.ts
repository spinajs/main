import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bootstrapper, DI } from '@spinajs/di';
import { ConfigVar, Configuration } from '@spinajs/configuration';
import type { IConfigLike } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { InvalidOption } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';

import { releaseHttpServer, req, TestConfiguration } from './common.js';
import { Controllers, HttpServer } from '../src/index.js';

const root = mkdtempSync(join(tmpdir(), 'static-enabled-'));
const folder = (name: string) => {
  const path = join(root, name);
  mkdirSync(path);
  writeFileSync(join(path, 'file.txt'), name);
  return path;
};

const plain = folder('plain');
const on = folder('on');
const off = folder('off');
const switched = folder('switched');
const unresolved = folder('unresolved');
const shared = folder('shared');
const missing = join(root, 'missing');

// A root hook: it runs whichever group of this file runs, and after both when both do.
after(() => rmSync(root, { recursive: true, force: true }));

let staticEntries: (cfg: Configuration) => object[] = () => [];

/** The test configuration, reloaded through `load()`, so ConfigVars are wrapped as in an app. */
class StaticConfiguration extends TestConfiguration {
  private loaded: IConfigLike = {};

  public async resolve(): Promise<void> {
    await super.resolve();
    const http = this.Config.http as Record<string, unknown>;
    this.loaded = { ...this.Config, staticTest: { debug: true }, http: { ...http, Static: staticEntries(this) } };
    // Only onLoad(): the file sources would bring in the config of every installed package.
    this.Sources = [];
    await this.load();
  }

  protected onLoad(): IConfigLike {
    return this.loaded;
  }
}

async function bootstrap() {
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }
  DI.register(StaticConfiguration).as(Configuration);
}

describe('http.Static entries with Enabled', function () {
  this.timeout(15000);

  const status = async (path: string) => (await req().get(path).set('Accept', 'application/json').send()).status;
  let warn: sinon.SinonSpy;
  let info: sinon.SinonSpy;

  before(async () => {
    staticEntries = (cfg) => [
      { Route: '/plain', Path: plain },
      { Route: '/on', Path: on, Enabled: true },
      { Route: '/off', Path: off, Enabled: false },
      { Route: '/switched', Path: switched, Enabled: new ConfigVar(() => cfg.get<boolean>('staticTest.debug')) },
      { Route: '/unresolved', Path: unresolved, Enabled: new ConfigVar(() => undefined) },
      { Route: '/shared-off', Path: shared, Enabled: false },
      { Route: '/shared-on', Path: shared },
      { Route: '/gone', Path: missing, Enabled: false },
    ];
    await bootstrap();
    const cfg = await DI.resolve(Configuration);
    // Changed after the load: the entry must read it when the server mounts, not when the configuration loads.
    cfg.set('staticTest.debug', false);
    const log = DI.resolve(Log, ['http']);
    warn = sinon.spy(log, 'warn');
    info = sinon.spy(log, 'info');
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();
  });

  after(async () => {
    warn.restore();
    info.restore();
    await releaseHttpServer();
    DI.uncache(Configuration);
    DI.uncache(StaticConfiguration);
  });

  it('serves an entry without Enabled and one with Enabled: true', async () => {
    expect(await status('plain/file.txt')).to.eq(200);
    expect(await status('on/file.txt')).to.eq(200);
  });

  it('does not serve an entry with Enabled: false', async () => {
    expect(await status('off/file.txt')).to.eq(404);
  });

  it('reads an Enabled ConfigVar when the server mounts', async () => {
    expect(await status('switched/file.txt')).to.eq(404);
  });

  it('serves an entry whose Enabled ConfigVar returns undefined', async () => {
    expect(await status('unresolved/file.txt')).to.eq(200);
  });

  it('a disabled entry does not hide an enabled one for the same folder', async () => {
    expect(await status('shared-off/file.txt')).to.eq(404);
    expect(await status('shared-on/file.txt')).to.eq(200);
  });

  it('logs no warning for a disabled entry whose folder is missing', () => {
    // The spied logger is the server's: it reported mounting the other folders.
    expect(info.getCalls().some((call) => JSON.stringify(call.args).includes('Serving static content'))).to.eq(true);
    const lines = warn.getCalls().map((call) => JSON.stringify(call.args));
    expect(lines.filter((line) => line.includes('missing'))).to.deep.equal([]);
  });
});

describe('http.Static entries with an Enabled that is not a boolean', function () {
  this.timeout(15000);

  async function startWith(enabled: unknown, first: object[] = []): Promise<Error | undefined> {
    staticEntries = () => [...first, { Route: '/strict', Path: on, Enabled: enabled }];
    DI.uncache(HttpServer);
    DI.uncache(Configuration);
    DI.uncache(StaticConfiguration);
    await DI.resolve(Configuration);
    try {
      await DI.resolve(HttpServer);
      return undefined;
    } catch (err) {
      return err as Error;
    } finally {
      DI.uncache(HttpServer);
      DI.uncache(Configuration);
      DI.uncache(StaticConfiguration);
    }
  }

  before(bootstrap);

  for (const [label, value, type] of [
    ["'false'", 'false', 'string'],
    ['0', 0, 'number'],
    ['null', null, 'null'],
    ['a ConfigVar returning a string', new ConfigVar(() => 'false'), 'string'],
  ] as const) {
    it(`stops the start for ${label}`, async () => {
      const err = await startWith(value);
      expect(err).to.be.instanceOf(InvalidOption);
      expect(err?.message).to.eq(`http.Static entry /strict: Enabled must be true, false or absent; got ${type}`);
    });
  }

  it('mounts nothing when a bad entry follows a good one', async () => {
    const info = sinon.spy(DI.resolve(Log, ['http']), 'info');
    try {
      const err = await startWith('yes', [{ Route: '/good', Path: plain }]);
      expect(err).to.be.instanceOf(InvalidOption);
      const mounted = info.getCalls().map((call) => JSON.stringify(call.args)).filter((line) => line.includes('Serving static content'));
      expect(mounted).to.deep.equal([]);
    } finally {
      info.restore();
    }
  });

  it('starts with Enabled absent and mounts both entries', async () => {
    const info = sinon.spy(DI.resolve(Log, ['http']), 'info');
    try {
      expect(await startWith(undefined, [{ Route: '/good', Path: plain }])).to.eq(undefined);
      const mounted = info.getCalls().map((call) => JSON.stringify(call.args)).filter((line) => line.includes('Serving static content'));
      expect(mounted).to.have.length(2);
    } finally {
      info.restore();
    }
  });
});
