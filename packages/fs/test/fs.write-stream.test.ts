import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import type { WriteStream } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';

import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/templates-pug';

import { TestConfiguration, dir } from './common.js';
import { FsBootstrapper, FsMiddleware, fsNative, fsService } from '../src/index.js';
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
});
