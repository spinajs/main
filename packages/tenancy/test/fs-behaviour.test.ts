import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DI } from '@spinajs/di';
import { FsMiddleware, fsService, getFs, publishedFs } from '@spinajs/fs';
import type { FsActionContext, fs } from '@spinajs/fs';
import { Log } from '@spinajs/log-common';
import type { ILogEntry } from '@spinajs/log-common';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { runInTenant } from '../src/index.js';
import '../src/fs.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

// What @spinajs/tenancy/fs does beside isolation; the isolation properties are pinned in fs.test.ts.
const root = join(tmpdir(), `tenancy-fs-behaviour-${process.pid}`);
const uploads = join(root, 'uploads');
const bucket = join(root, 'bucket');
const other = join(root, 'other');

class SilentLog extends Log {
  public trace(): void {}
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public fatal(): void {}
  public security(): void {}
  public success(): void {}
  public write(_entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    return Promise.resolve([]);
  }
}

class Recorder extends FsMiddleware {
  public static seen: string[] = [];

  public override order = 1;

  public before(ctx: FsActionContext): Promise<void> {
    Recorder.seen.push(...ctx.targets.map((target) => `${target.fs.Name}:${target.path}`));
    return Promise.resolve();
  }
}

const tenantFile = (tenant: string, file: string) => join(uploads, 'tenants', tenant, file);

const finish = (stream: Awaited<ReturnType<fs['writeStream']>>, data: string) =>
  new Promise<void>((resolve, reject) => {
    stream.on('close', () => resolve());
    stream.on('error', reject);
    stream.end(data);
  });

function boot(tenancy: Record<string, unknown>): Promise<TestApp> {
  for (const dir of [uploads, bucket, other]) mkdirSync(dir, { recursive: true });
  const providers = [uploads, bucket, other].map((basePath) => ({ service: 'fsNative', name: basePath.slice(root.length + 1), basePath }));
  return createTestApp({
    config: { tenancy: { fs: tenancy }, fs: { defaultProvider: 'other', providers } },
    register: (container) => container.register(SilentLog).as(Log),
    resolve: [fsService],
  });
}

describe('files per tenant: behaviour', function () {
  this.timeout(60000);
  let app: TestApp;

  before(async () => {
    DI.register(Recorder).as(FsMiddleware);
    app = await boot({ prefixed: ['uploads'], dedicated: { uploads: { bigcorp: 'bucket' } } });
    DI.uncache(Array.ofType(FsMiddleware));
  });

  after(async () => {
    await app?.dispose();
    DI.unregister(Recorder);
    DI.uncache(Array.ofType(FsMiddleware));
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    Recorder.seen = [];
  });

  it("middlewares see the application's path on the provider name it uses, once", async () => {
    await runInTenant('alpha', () => getFs('uploads').write('a.txt', 'x'));

    expect(Recorder.seen).to.deep.equal(['uploads:a.txt']);
  });

  it('copies, renames and streams inside the tenant', async () => {
    await runInTenant('gamma', async () => {
      const files = getFs('uploads');
      await files.write('a.txt', 'A');
      await files.copy('a.txt', 'b.txt');
      await files.rename('b.txt', 'c.txt');
      const stream = await files.writeStream('d.txt');
      await finish(stream, 'D');
    });

    expect(readFileSync(tenantFile('gamma', 'c.txt'), 'utf-8')).to.equal('A');
    expect(readFileSync(tenantFile('gamma', 'd.txt'), 'utf-8')).to.equal('D');
    expect(existsSync(tenantFile('gamma', 'b.txt'))).to.equal(false);
  });
});

describe('files per tenant: nothing listed', function () {
  this.timeout(60000);

  after(() => rmSync(root, { recursive: true, force: true }));

  it('with no provider listed every provider is handed out and acts as published', async () => {
    const app = await boot({});
    try {
      expect(getFs('uploads')).to.equal(publishedFs('uploads'));
      await getFs('uploads').write('plain.txt', 'x');
      await runInTenant('alpha', () => publishedFs('uploads')!.write('plain-in-tenant.txt', 'y'));
      expect(readdirSync(uploads)).to.include.members(['plain.txt', 'plain-in-tenant.txt']);
    } finally {
      await app.dispose();
    }
  });
});
