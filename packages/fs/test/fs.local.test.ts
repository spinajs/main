import 'mocha';

import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, FsBootsrapper } from './../src/index.js';
import '@spinajs/templates-pug';
import { dir, TestConfiguration } from './common.js';
import { expect } from 'chai';
import { join } from 'path';
import { IOFail } from '@spinajs/exceptions';
import { cp, rm } from 'fs/promises';

async function f() {
  return await DI.resolve<fs>('__file_provider__', ['test']);
}

async function f2() {
  return await DI.resolve<fs>('__file_provider__', ['test-2']);
}

async function fTemp() {
  return await DI.resolve<fs>('__file_provider__', ['fs-temp']);
}

describe('fs local tests', function () {
  this.timeout(15000);

  before(async () => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  after(async () => {});

  beforeEach(async () => {
    try {
      await rm(join(dir('./files')), { recursive: true });
    } catch {}

    await cp(join(dir('./files_restore')), join(dir('./files')), { recursive: true, force: true });
  });

  afterEach(async () => {
    sinon.restore();
  });

  it('Should list files in dir', async () => {
    const _f = await f();
    const files = await _f.list('/');

    expect(files.length).to.be.gte(5);
    expect(files).to.include.members(['SamplePNGImage_100kbmb.png', 'test.txt', 'zipped.zip', 'zipped_dir.zip']);
  });

  it('should read file', async () => {
    const _f = await f();

    const r = await _f.read('test.txt', 'utf-8');
    expect(r).to.eq('hello world');
  });

  it('should write to file', async () => {
    const _f = await f();
    await _f.write('write.txt', 'hello world', 'utf-8');

    const ex = await _f.exists('write.txt');
    expect(ex).to.be.true;

    const content = await _f.read('write.txt', 'utf-8');
    expect(content).to.eq('hello world');
  });

  it('should delete file', async () => {
    const _f = await f();

    let ex = await _f.exists('test.txt');
    expect(ex).to.be.true;

    await _f.rm('test.txt');
    ex = await _f.exists('test.txt');
    expect(ex).to.be.false;
  });

  it('should move file', async () => {
    const _f = await f();
    await _f.write('move.txt', 'hello world', 'utf-8');
    await _f.move('move.txt', 'moved.txt');

    const ex = await _f.exists('move.txt');
    const ex2 = await _f.exists('moved.txt');

    expect(ex).to.be.false;
    expect(ex2).to.be.true;
  });

  it('should move between fs', async () => {
    const _f = await f();
    const _f2 = await f2();

    await _f.write('move-bewtween.txt', 'hello world', 'utf-8');
    await _f.move('move-bewtween.txt', 'move-bewtween.txt', _f2);

    const ex = _f.exists('move-bewtween.txt');
    const ex2 = _f2.exists('move-bewtween.txt');

    expect(ex).to.be.false;
    expect(ex2).to.be.true;
  });

  it('should copy dir', async () => {
    const _f = await f();
    await _f.copy('dir_zip', 'dir_zip_copy');

    const exists = await _f.exists('dir_zip_copy');
    const isDir = await _f.isDir('dir_zip_copy');

    expect(exists).to.be.true;
    expect(isDir).to.be.true;
  });

  it('Should upload dir', async () => {
    const _f = await f();
    const srcDir = _f.resolvePath('dir_zip');

    await _f.upload(srcDir, 'dir_zip_uploaded');

    const exists = await _f.exists('dir_zip_uploaded');
    const isDir = await _f.isDir('dir_zip_uploaded');

    expect(exists).to.be.true;
    expect(isDir).to.be.true;
  });

  it('Should delete dir', async () => {
    const _f = await f();
    await _f.copy('dir_zip', 'dir_zip_copy');

    let exists = await _f.exists('dir_zip_copy');
    let isDir = await _f.isDir('dir_zip_copy');

    expect(exists).to.be.true;
    expect(isDir).to.be.true;

    await _f.rm('dir_zip_copy');

    exists = await _f.exists('dir_zip_copy');
    isDir = await _f.isDir('dir_zip_copy');

    expect(exists).to.be.false;
    expect(isDir).to.be.false;
  });

  it('should move dir between fs', async () => {
    const _f = await f();
    const _f2 = await f2();

    _f.move('dir_zip_copy', 'dir_zip_copy', _f2);

    const exists = await _f2.exists('dir_zip_copy');
    const isDir = await _f2.isDir('dir_zip_copy');

    expect(exists).to.be.true;
    expect(isDir).to.be.true;
  });

  it('should copy between fs', async () => {
    const _f = await f();
    const _f2 = await f2();

    await _f.write('copy-bewtween.txt', 'hello world', 'utf-8');
    await _f.copy('copy-bewtween.txt', 'move-bewtween.txt', _f2);

    const ex = _f.exists('move-bewtween.txt');
    const ex2 = _f2.exists('move-bewtween.txt');

    expect(ex).to.be.false;
    expect(ex2).to.be.true;
  });

  it('Should throw on copy and file not exists', async () => {
    const _f = await f();
    expect(_f.copy('not_exists.txt', 'not_exists_copy.txt')).should.rejectedWith(IOFail);
  });

  it('Should throw on move when not exists', async () => {
    const _f = await f();
    expect(_f.move('not_exists.txt', 'not_exists_copy.txt')).should.rejectedWith(IOFail);
  });

  it('Should throw when unlink not exists', async () => {
    const _f = await f();
    expect(_f.rm('not_exists.txt')).should.rejectedWith(IOFail);
  });

  it('should get file stats', async () => {
    const _f = await f();
    const result = await _f.stat('test.txt');
    expect(result).to.be.not.null;
  });

  it('should zip file', async () => {
    const _f = await f();
    const _tmp = await fTemp();
    const result = await _f.zip('text.txt');

    const exist = await _tmp.exists(result.asFilePath());
    expect(exist).to.be.true;
  });

  it('Should fail on zip not existing file or dir', async () => {
    const _f = await f();
    expect(_f.zip('text-not-exists.txt')).should.rejectedWith(IOFail);
  });

  it('should unzip file', async () => {
    const _f = await f();

    await _f.unzip('zipped.zip', 'zipped');

    const exist = _f.exists('zipped.txt');
    expect(exist).to.be.true;
  });

  it('Should zip dir', async () => {
    const _f = await f();
    const _tmp = await fTemp();
    const result = await _f.zip('dir_zip');

    const exist = await _tmp.exists(result.asFilePath());
    expect(exist).to.be.true;
  });

  it('Should unzip dir', async () => {
    const _f = await f();
    await _f.unzip('zipped_dir', 'zipped_dir');

    const exist = await _f.exists('zipped_dir');
    const exist2 = await _f.exists('zipped_dir/test.txt');
    expect(exist).to.be.true;
    expect(exist2).to.be.true;
  });

  it('Should unzip to another fs', async () => {
    const _f = await f();
    const _f2 = await f2();
    await _f.unzip('zipped_dir', 'zipped_dir', _f2);

    const exist = await _f2.exists('zipped_dir');
    const exist2 = await _f2.exists('zipped_dir/test.txt');
    expect(exist).to.be.true;
    expect(exist2).to.be.true;
  });

  it('Should zip and move to another fs', async () => {
    const _f = await f();
    const _f2 = await f2();
    const result = await _f.zip('dir_zip', _f2);

    const exist = await _f2.exists(result.asFilePath());
    expect(exist).to.be.true;
  });

  it('Should zip multiple files', async () => {
    const _f = await f();
    const result = await _f.zip(['SamplePNGImage_100kbmb.png', 'test.txt']);
    const exist = await _f.exists(result.asFilePath());
    expect(exist).to.be.true;
  });
});
