/* eslint-disable security/detect-non-literal-fs-filename */
import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { readdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { IOFail, ResourceDuplicated } from '@spinajs/exceptions';
import '@spinajs/templates-pug';

import { TestConfiguration, dir } from './common.js';
import { FsBootstrapper, FsMiddleware, fs, fsNative, fsService, getFs, URI } from '../src/index.js';
import type { FsActionContext, IFsLocalOptions, IWriteStreamOptions } from '../src/index.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const seen: FsActionContext[] = [];

class WriteRecorder extends FsMiddleware {
  public order = 1;
  async before(ctx: FsActionContext) {
    if (ctx.action === 'writeStream') seen.push(ctx);
  }
}

type HookCall = [string, NodeJS.ReadableStream | undefined, IWriteStreamOptions];

class RecordingFs extends fsNative<IFsLocalOptions> {
  public calls: HookCall[] = [];

  protected async doWriteStream(path: string, readStream: NodeJS.ReadableStream | undefined, options: IWriteStreamOptions): Promise<WriteStream> {
    this.calls.push([path, readStream, options]);
    // The hook is typed after fsNative's; the recorder never writes, so any stream does.
    return new PassThrough() as unknown as WriteStream;
  }
}

describe('fs writeStream options', function () {
  this.timeout(15000);
  let recording: RecordingFs;

  before(async () => {
    DI.resolve(FsBootstrapper).bootstrap();
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    DI.register(WriteRecorder).as(FsMiddleware);
    DI.uncache(Array.ofType(FsMiddleware));
  });

  after(() => {
    DI.unregister(WriteRecorder);
    DI.uncache(Array.ofType(FsMiddleware));
  });

  beforeEach(() => {
    seen.length = 0;
    recording = new RecordingFs({ name: 'recording', service: 'fsNative', basePath: dir('./temp-nc') } as IFsLocalOptions);
  });

  describe('overload normalisation', () => {
    it('hands the hook no stream and empty options for a bare path', async () => {
      await recording.writeStream('a.txt');
      expect(recording.calls).to.deep.equal([['a.txt', undefined, {}]]);
    });

    it('reads a string in the second place as the encoding', async () => {
      await recording.writeStream('a.txt', 'latin1');
      expect(recording.calls).to.deep.equal([['a.txt', undefined, { encoding: 'latin1' }]]);
    });

    it('reads a plain object in the second place as the options', async () => {
      const options: IWriteStreamOptions = { exclusive: true, contentType: 'text/plain', metadata: { hash: 'h' } };
      await recording.writeStream('a.txt', options);
      expect(recording.calls).to.deep.equal([['a.txt', undefined, options]]);
    });

    it('reads anything with pipe in the second place as the source stream', async () => {
      const source = Readable.from(['x']);
      await recording.writeStream('a.txt', source);
      await recording.writeStream('b.txt', source, 'utf-8');
      await recording.writeStream('c.txt', source, { exclusive: true });
      expect(recording.calls.map(([p, r, o]) => [p, r === source, o])).to.deep.equal([
        ['a.txt', true, {}],
        ['b.txt', true, { encoding: 'utf-8' }],
        ['c.txt', true, { exclusive: true }],
      ]);
    });

    it('takes the options from the third place when an untyped caller passes no stream', async () => {
      await recording.writeStream('a.txt', undefined as unknown as NodeJS.ReadableStream, 'utf-8');
      expect(recording.calls).to.deep.equal([['a.txt', undefined, { encoding: 'utf-8' }]]);
    });
  });

  describe('middleware', () => {
    it('sees [source stream or undefined, normalised options] as the action args', async () => {
      const source = Readable.from(['x']);
      await recording.writeStream('a.txt', 'utf-8');
      await recording.writeStream('/b.txt', source, { exclusive: true });
      expect(seen.map((c) => [c.targets[0].path, c.args[0] === source, c.args[1]])).to.deep.equal([
        ['a.txt', false, { encoding: 'utf-8' }],
        ['b.txt', true, { exclusive: true }],
      ]);
      expect(recording.calls.map(([p]) => p)).to.deep.equal(['a.txt', 'b.txt']);
    });

    it('hands the hook the options a middleware edited, never touching the caller object', async () => {
      class ForceExclusive extends FsMiddleware {
        public order = 2;
        async before(ctx: FsActionContext) {
          if (ctx.action === 'writeStream') (ctx.args[1] as IWriteStreamOptions).exclusive = true;
        }
      }
      DI.register(ForceExclusive).as(FsMiddleware);
      DI.uncache(Array.ofType(FsMiddleware));
      const options: IWriteStreamOptions = { encoding: 'utf-8' };
      try {
        await recording.writeStream('a.txt', options);
      } finally {
        DI.unregister(ForceExclusive);
        DI.uncache(Array.ofType(FsMiddleware));
      }
      expect(recording.calls[0][2]).to.deep.equal({ encoding: 'utf-8', exclusive: true });
      expect(options).to.deep.equal({ encoding: 'utf-8' });
    });
  });

  describe('fsNative exclusive', () => {
    const root = () => join(dir('./temp-nc'), 'ws');
    let local: fs;
    let temp: fs;

    const closed = (stream: NodeJS.WritableStream): Promise<void> =>
      new Promise((resolve, reject) => {
        stream.on('close', () => resolve());
        stream.on('error', reject);
      });

    const writeAll = async (stream: NodeJS.WritableStream, data: string): Promise<void> => {
      const done = closed(stream);
      stream.end(data);
      await done;
    };

    const seed = async (name: string, content: string): Promise<void> => {
      await mkdir(dirname(join(root(), name)), { recursive: true });
      await writeFile(join(root(), name), content);
    };

    before(() => {
      local = getFs('fs-temp-nc-local');
      temp = getFs('fs-temp-nc');
    });

    beforeEach(async () => {
      await rm(root(), { recursive: true, force: true });
    });

    it('creates the file and its missing parent dirs', async () => {
      await writeAll(await local.writeStream('ws/a/b/new.txt', { exclusive: true }), 'hello');
      expect(await readFile(join(root(), 'a/b/new.txt'), 'utf-8')).to.equal('hello');
    });

    it('refuses an existing file with ResourceDuplicated and keeps its content', async () => {
      await seed('old.txt', 'old');
      await expect(local.writeStream('ws/old.txt', { exclusive: true })).to.be.rejectedWith(ResourceDuplicated);
      expect(await readFile(join(root(), 'old.txt'), 'utf-8')).to.equal('old');
    });

    it('refuses an existing file also when a source stream is given, leaving the source unread', async () => {
      await seed('old.txt', 'old');
      const source = Readable.from(['new']);
      await expect(local.writeStream('ws/old.txt', source, { exclusive: true })).to.be.rejectedWith(ResourceDuplicated);
      expect(await readFile(join(root(), 'old.txt'), 'utf-8')).to.equal('old');
      expect(source.readableFlowing).to.equal(null);
    });

    it('writes a source stream into a new file', async () => {
      const source = new PassThrough();
      const stream = await local.writeStream('ws/s.txt', source, { exclusive: true });
      const done = closed(stream);
      source.end('abc');
      await done;
      expect(await readFile(join(root(), 's.txt'), 'utf-8')).to.equal('abc');
    });

    it('lets exactly one of concurrent exclusive writes to one path win', async () => {
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => local.writeStream('ws/race.txt', { exclusive: true })));
      const won = results.filter((r): r is PromiseFulfilledResult<WriteStream | PassThrough> => r.status === 'fulfilled');
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(won).to.have.length(1);
      expect(lost.filter((r) => r.reason instanceof ResourceDuplicated)).to.have.length(7);
      await writeAll(won[0].value, 'winner');
      expect(await readFile(join(root(), 'race.txt'), 'utf-8')).to.equal('winner');
    });

    it('reports a parent path that is a file as IOFail, not ResourceDuplicated', async () => {
      await seed('file.txt', 'x');
      await expect(local.writeStream('ws/file.txt/child.txt', { exclusive: true })).to.be.rejectedWith(IOFail);
    });

    it('reports a deeper ancestor that is a file as IOFail, not ResourceDuplicated', async () => {
      await seed('file.txt', 'x');
      const err = await local.writeStream('ws/file.txt/sub/part', { exclusive: true }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).to.be.instanceOf(IOFail);
      expect(err).to.not.be.instanceOf(ResourceDuplicated);
    });

    it('writes with the encoding from the options or a bare encoding', async () => {
      await writeAll(await local.writeStream('ws/options.txt', { exclusive: true, encoding: 'latin1' }), 'é');
      await writeAll(await local.writeStream('ws/bare.txt', 'latin1'), 'é');
      expect([...(await readFile(join(root(), 'options.txt')))]).to.deep.equal([0xe9]);
      expect([...(await readFile(join(root(), 'bare.txt')))]).to.deep.equal([0xe9]);
    });

    it('accepts contentType and metadata and stores only the bytes', async () => {
      await writeAll(await local.writeStream('ws/m.txt', { exclusive: true, contentType: 'application/json', metadata: { hash: 'abc' } }), '{}');
      expect(await readFile(join(root(), 'm.txt'), 'utf-8')).to.equal('{}');
      expect(readdirSync(root())).to.deep.equal(['m.txt']);
    });

    it('still overwrites without exclusive', async () => {
      await seed('over.txt', 'old');
      await writeAll(await local.writeStream('ws/over.txt'), 'new');
      expect(await readFile(join(root(), 'over.txt'), 'utf-8')).to.equal('new');
    });

    it('runs after hooks once an exclusive write closed, and none for a refused one', async () => {
      const after: string[] = [];
      class AfterRecorder extends FsMiddleware {
        public order = 3;
        async before() {}
        async after(ctx: FsActionContext, result: unknown) {
          if (ctx.action === 'writeStream') after.push(ctx.targets[0].path);
          return result;
        }
      }
      DI.register(AfterRecorder).as(FsMiddleware);
      DI.uncache(Array.ofType(FsMiddleware));
      try {
        await writeAll(await local.writeStream('ws/hooked.txt', { exclusive: true }), 'x');
        await expect(local.writeStream('ws/hooked.txt', { exclusive: true })).to.be.rejectedWith(ResourceDuplicated);
      } finally {
        DI.unregister(AfterRecorder);
        DI.uncache(Array.ofType(FsMiddleware));
      }
      expect(after).to.deep.equal(['ws/hooked.txt']);
    });

    it('fsTemp forwards the options to its backend, the middleware seeing the fsTemp action only', async () => {
      await seed('t.txt', 'old');
      seen.length = 0;
      await expect(temp.writeStream('ws/t.txt', { exclusive: true })).to.be.rejectedWith(ResourceDuplicated);
      expect(seen.map((c) => `${c.fs.Name}:${JSON.stringify(c.args[1])}`)).to.deep.equal(['fs-temp-nc:{"exclusive":true}']);
      await writeAll(await temp.writeStream('ws/t2.txt', { exclusive: true, encoding: 'latin1' }), 'é');
      expect([...(await readFile(join(root(), 't2.txt')))]).to.deep.equal([0xe9]);
    });

    it('takes the options through the static fs.writeStream', async () => {
      const uri = new URI('fs://fs-temp-nc-local/ws/static.txt');
      await writeAll(await fs.writeStream(uri, { exclusive: true }), 'x');
      await expect(fs.writeStream(uri, { exclusive: true })).to.be.rejectedWith(ResourceDuplicated);
      expect(await readFile(join(root(), 'static.txt'), 'utf-8')).to.equal('x');
    });
  });
});
