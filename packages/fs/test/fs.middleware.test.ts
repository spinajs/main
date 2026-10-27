import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { DI } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, ResourceDuplicated } from '@spinajs/exceptions';

import { dir, fsApp } from './common.js';
import { FsMiddleware, fs, fsNative, fsService, getFs, publishedFs } from '../src/index.js';
import type { FsActionContext, IFsLocalOptions } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

chai.use(chaiAsPromised);
const expect = chai.expect;

const seen: FsActionContext[] = [];

class Recorder extends FsMiddleware {
  public order = 1;
  async before(ctx: FsActionContext) {
    seen.push(ctx);
  }
}

const describeTargets = (ctx: FsActionContext) => ctx.targets.map((t) => `${t.fs.Name}:${t.path}:${t.kind}:${t.access.join('+')}:${t.role}`);

describe('fs middleware pipeline', function () {
  this.timeout(15000);
  let local: fs;
  let temp: fs;

  let app: TestApp;

  before(async () => {
    app = await fsApp({ resolve: [fsService] });
    DI.register(Recorder).as(FsMiddleware);
    DI.uncache(Array.ofType(FsMiddleware));
    local = getFs('fs-temp-nc-local');
    temp = getFs('fs-temp-nc');
  });

  after(async () => {
    await app.dispose();
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it('checks write on the normalised path and hands the provider that path', async () => {
    await local.write('/docs/../a.txt', 'x');
    expect(describeTargets(seen[0])).to.deep.equal(['fs-temp-nc-local:a.txt:file:write:source']);
    expect(await local.read('a.txt', 'utf-8')).to.equal('x');
  });

  it('hasEntries is a list action on a dir target: true only for a directory holding an entry', async () => {
    await local.mkdir('he/sub');
    await local.write('he/sub/a.txt', 'x');
    await local.mkdir('he-empty');
    seen.length = 0;
    const answers = [];
    for (const path of ['he', 'he/sub', 'he-empty', 'he/sub/a.txt', 'he-missing']) answers.push(await local.hasEntries(path));
    expect(answers).to.deep.equal([true, true, false, false, false]);
    expect(describeTargets(seen[0])).to.deep.equal(['fs-temp-nc-local:he:dir:list:source']);
  });

  it('fsTemp asks its backend for hasEntries', async () => {
    const backend = (temp as unknown as { Provider: fs }).Provider as fs & { hasEntries(path: string): Promise<boolean> };
    const asked: string[] = [];
    backend.hasEntries = async (path: string) => (asked.push(path), true);
    try {
      expect(await temp.hasEntries('/x/../d')).to.equal(true);
    } finally {
      delete (backend as { hasEntries?: unknown }).hasEntries;
    }
    expect(asked).to.deep.equal(['d']);
  });

  it('makes an absolute path inside the base path relative', async () => {
    await local.exists(join(dir('./temp-nc'), 'a.txt'));
    expect(seen[0].targets[0].path).to.equal('a.txt');
  });

  it('refuses a path above the root before any middleware runs', async () => {
    await expect(local.read('../outside.txt')).to.be.rejectedWith(InvalidArgument);
    expect(seen).to.have.length(0);
  });

  it('does not run middlewares for calls the provider makes inside an action', async () => {
    await local.write('b.txt', 'x');
    seen.length = 0;
    await local.readStream('b.txt'); // fsNative.doReadStream calls this.exists() internally
    expect(seen.map((c) => c.action)).to.deep.equal(['readStream']);
  });

  it('targets the destination fs of a copy', async () => {
    await local.write('c.txt', 'x');
    seen.length = 0;
    await local.copy('c.txt', 'copied/c.txt', temp);
    expect(describeTargets(seen[0])).to.deep.equal(['fs-temp-nc-local:c.txt:file:read:source', 'fs-temp-nc:copied/c.txt:file:write:destination']);
  });

  it('checks move as read+delete on the source', async () => {
    await local.write('d.txt', 'x');
    seen.length = 0;
    await local.move('d.txt', 'e.txt');
    expect(describeTargets(seen[0])).to.deep.equal(['fs-temp-nc-local:d.txt:file:read+delete:source', 'fs-temp-nc-local:e.txt:file:write:destination']);
  });

  it('names the upload destination after the source file when none is given', async () => {
    await local.upload(join(dir('./sample-files'), readFirstSample()));
    expect(seen[0].targets[0].path).to.equal(readFirstSample());
    expect(seen[0].args).to.deep.equal([join(dir('./sample-files'), readFirstSample()), undefined]);
  });

  it('hands upload options to the middleware and refuses an exclusive upload onto an existing file', async () => {
    const src = join(dir('./sample-files'), readFirstSample());
    await local.upload(src, 'excl/sample.bin');
    seen.length = 0;
    await expect(local.upload(src, 'excl/sample.bin', { exclusive: true })).to.be.rejectedWith(ResourceDuplicated);
    expect(seen.map((c) => c.action)).to.deep.equal(['upload']);
    expect(describeTargets(seen[0])).to.deep.equal(['fs-temp-nc-local:excl/sample.bin:file:write:destination']);
    expect(seen[0].args[1]).to.deep.equal({ exclusive: true });
  });

  it('forwards exclusive uploads from fsTemp to its backend', async () => {
    await temp.write('t-excl.txt', 'x');
    seen.length = 0;
    await expect(temp.upload(join(dir('./sample-files'), readFirstSample()), 't-excl.txt', { exclusive: true })).to.be.rejectedWith(ResourceDuplicated);
    expect(seen.map((c) => `${c.fs.Name}:${c.action}:${JSON.stringify(c.args[1])}`)).to.deep.equal(['fs-temp-nc:upload:{"exclusive":true}']);
    expect(await temp.read('t-excl.txt', 'utf-8')).to.equal('x');
  });

  it('computes the zip destination and name before the IO, on fs-temp for fsNative', async () => {
    await local.write('z.txt', 'x');
    seen.length = 0;
    const result = await local.zip('z.txt');
    const ctx = seen.find((c) => c.action === 'zip')!;
    const dst = ctx.targets[ctx.targets.length - 1];
    expect(dst.fs.Name).to.equal('fs-temp');
    expect(dst.path).to.match(/\.zip$/);
    expect(result.fs.Name).to.equal('fs-temp');
  });

  it('zip and unzip reject, never throw, when the default destination or its temp name fails', async () => {
    class NoDestinations extends fsNative<IFsLocalOptions> {
      protected zipDestination(): fs {
        throw new InvalidOperation('no zip destination');
      }
      protected unzipDestination(): fs {
        throw new InvalidOperation('no unzip destination');
      }
    }
    const broken = new NoDestinations({ name: 'no-dst', service: 'fsNative', basePath: dir('./temp-nc') } as IFsLocalOptions);
    const unnamed = new fsNative<IFsLocalOptions>({ name: 'no-name', service: 'fsNative', basePath: dir('./temp-nc') } as IFsLocalOptions);
    unnamed.tmpname = () => {
      throw new InvalidOperation('no temp name');
    };
    const calls: [() => Promise<unknown>, string][] = [
      [() => broken.zip('z.txt'), 'no zip destination'],
      [() => broken.unzip('a.zip'), 'no unzip destination'],
      [() => local.zip('z.txt', unnamed), 'no temp name'],
      [() => local.unzip('a.zip', undefined, unnamed), 'no temp name'],
    ];
    for (const [call, message] of calls) {
      let pending: Promise<unknown> | undefined;
      expect(() => (pending = call()), message).to.not.throw();
      await expect(pending).to.be.rejectedWith(InvalidOperation, message);
    }
  });

  it('checks list as a dir target', async () => {
    await local.list('');
    expect(describeTargets(seen[0])).to.deep.equal(['fs-temp-nc-local::dir:list:source']);
  });

  it('routes fsTemp actions through its own targets, its backend unchecked', async () => {
    await temp.write('t.txt', 'x');
    expect(seen.map((c) => `${c.fs.Name}:${c.action}`)).to.deep.equal(['fs-temp-nc:write']);
  });

  it('throws MethodNotImplemented for signedUrl on a provider without signed URLs', async () => {
    await expect(local.signedUrl('a.txt')).to.be.rejectedWith(/signed URL/);
  });

  it('refuses a provider class that overrides a public action', () => {
    class BadFs extends fsNative<IFsLocalOptions> {
      public async read(): Promise<string> {
        return 'bypass';
      }
    }
    expect(() => new BadFs({ name: 'bad', service: 'fsNative', basePath: dir('./temp-nc') } as IFsLocalOptions)).to.throw(InvalidOperation, /BadFs overrides read; implement doRead instead/);
  });

  it('publishes the provider instances themselves', () => {
    const published = publishedFs('fs-temp-nc-local');
    expect(published).to.equal(local);
    expect(published!.constructor.name).to.equal('fsNative');
    expect(publishedFs('fs-temp-nc')!.constructor.name).to.equal('fsTemp');
  });
});

function readFirstSample(): string {
  return readdirSync(dir('./sample-files')).find((f) => !f.startsWith('.'))!;
}
