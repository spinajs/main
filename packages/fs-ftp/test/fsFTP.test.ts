import 'mocha';

import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, FsBootsrapper, fsService } from '@spinajs/fs';
import '../src/index.js';
import '@spinajs/templates-pug';
import { TestConfiguration } from './common.js';
import { expect } from 'chai';
import { fsFTP } from '../src/index.js';

async function f() {
  return await DI.resolve<fs>('__file_provider__', ['ftp']);
}

async function fl() {
  return await DI.resolve<fs>('__file_provider__', ['test']);
}

describe('fs ftp basic tests', function () {
  this.timeout(65000);

  before(async () => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);

    await DI.resolve(fsService);
  });

  after(async () => {});

  afterEach(() => {
    sinon.restore();
  });

  it('Should register in di container', () => {
    const registered = DI.checkType(fs, fsFTP);
    expect(registered).to.be.true;
  });

  it('should write to file', async () => {
    const ftp = await f();
    await ftp.write('test.txt', 'hello world');
    const exists = await ftp.exists('test.txt');
    expect(exists).to.be.true;
  });

  it('should write to file in subfolder', async () => {
    const ftp = await f();
    await ftp.write('sub/test.txt', 'hello world');
    const exists = await ftp.exists('sub/test.txt');
    expect(exists).to.be.true;
  });

  it('should upload file', async () => {
    const ftp = await f();
    const ft = await fl();

    const toUpload = await ft.download('Big_Buck_Bunny_1080_10s_30MB.mp4');

    await ftp.upload(toUpload, 'Big_Buck_Bunny_1080_10s_30MB.mp4');
    const exists = await ftp.exists('Big_Buck_Bunny_1080_10s_30MB.mp4');
    expect(exists).to.be.true;
  });

  it('should upload file to subfolder', async () => {
    const ftp = await f();
    const ft = await fl();

    const toUpload = await ft.download('Big_Buck_Bunny_1080_10s_30MB.mp4');

    await ftp.upload(toUpload, 'big/Big_Buck_Bunny_1080_10s_30MB.mp4');
    const exists = await ftp.exists('big/Big_Buck_Bunny_1080_10s_30MB.mp4');
    expect(exists).to.be.true;
  });

  it('should read file', async () => {
    const ftp = await f();
    const content = await ftp.read('test.txt');
    expect(content).to.eq('hello world');
  });

  it(`file exists should return false`, async () => {
    const ftp = await f();
    const exists = await ftp.exists('notexists.txt');
    expect(exists).to.be.false;
  });

  it('should list files', async () => {
    const ftp = await f();
    const files = await ftp.list('/');
    expect(files.length).to.be.greaterThan(0);
    expect(files).to.include('test.txt');
  });

  it('should remove files', async () => {
    const ftp = await f();
    await ftp.rm('test.txt');
    const exists = await ftp.exists('test.txt');
    expect(exists).to.be.false;
  });
});
