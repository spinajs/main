import 'mocha';

import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, FsBootsrapper, fsService } from '@spinajs/fs';
import './../src/index.js';
import '@spinajs/templates-pug';
import { TestConfiguration } from './common.js';
import { fsS3 } from './../src/index.js';
import { existsSync, statSync } from 'fs';
import { expect } from 'chai';

async function f() {
  return await DI.resolve<fs>('__file_provider__', ['aws']);
}

async function fl() {
  return await DI.resolve<fs>('__file_provider__', ['test']);
}

async function ft() {
  return await DI.resolve<fs>('__file_provider__', ['fs-temp-s3']);
}

describe('fs s3 basic tests', function () {
  this.timeout(65000);

  before(async () => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
  
  });

  after(async () => {
    // Cleanup all providers to allow process to exit
    try {
      const f3 = await f();
      await f3.dispose();
      
      const fLocal = await fl();
      await fLocal.dispose();
      
      const fTemp = await ft();
      await fTemp.dispose();
    } catch (err) {
      console.error('Error during cleanup:', err);
    }
  });

  afterEach(() => {
    sinon.restore();
  });

  it('Should register in di container', () => {
    const registered = DI.checkType(fs, fsS3);
    expect(registered).to.be.true;
  });

  it('should check if file not exists', async () => {
    const f3 = await f();
    const exists = await f3.exists('nonExists.txt');
    expect(exists).to.be.false;
  });

  it('should upload file', async () => {
    const f3 = await f();
    await f3.write('test.txt', 'hello world');
    const exists = await f3.exists('test.txt');
    expect(exists).to.be.true;
  });

  it('should read file', async () => {
    const f3 = await f();
    const content = await f3.read('test.txt');

    expect(content).to.eq('hello world');
  }); 

  it('Should readable stream work', async () => {
    const f3 = await f();
    const t = await ft();

    const path = t.tmpname();
    const wstream = await t.writeStream(path);
    const rstream = await f3.readStream('test.txt');

    await new Promise<void>((resolve) => {
      rstream.pipe(wstream).on('close', () => {
        t.read(path).then((result) => {
          expect(result).to.equal('hello world');
          resolve();
        });
      });
    });
  });

  it('Should append to file', async () => {
    const f3 = await f();

    await f3.append('test.txt', ' hello world 2');

    const content = await f3.read('test.txt');

    expect(content).to.eq('hello world hello world 2');
  });

  it('should delete file', async () => {
    const f3 = await f();
    await f3.rm('test.txt');

    const exists = await f3.exists('test.txt');
    expect(exists).to.be.false;
  });

  it('should upload big file', async () => {
    const f3 = await f();
    const fLocal = await fl();

    await f3.rm('Big_Buck_Bunny_1080_10s_30MB.mp4');

    let ex = await f3.exists('Big_Buck_Bunny_1080_10s_30MB.mp4');
    expect(ex).to.be.false;

    await f3.upload(fLocal.resolvePath('Big_Buck_Bunny_1080_10s_30MB.mp4'));

    ex = await f3.exists('Big_Buck_Bunny_1080_10s_30MB.mp4');
    expect(ex).to.be.true;

    const lStat = await fLocal.stat('Big_Buck_Bunny_1080_10s_30MB.mp4');
    const stat = await f3.stat('Big_Buck_Bunny_1080_10s_30MB.mp4');

    expect(stat.Size).to.eq(lStat.Size);
  });

  it('should download file', async () => {
    const f3 = await f();
    const file = await f3.download('Big_Buck_Bunny_1080_10s_30MB.mp4');

    expect(file).to.be.not.null;
    expect(file).to.be.not.undefined;
    expect(existsSync(file)).to.be.true;

    const stat = await f3.stat('Big_Buck_Bunny_1080_10s_30MB.mp4');
    const lStat = statSync(file);

    expect(stat.Size).to.eq(lStat.size);
  });

  it('should retrieve file medata', async () => {
    const f3 = (await f()) as fsS3;

    const m = await f3.getMetadata('Big_Buck_Bunny_1080_10s_30MB.mp4');

    expect(m.height).to.eq('1080');
  });
});
