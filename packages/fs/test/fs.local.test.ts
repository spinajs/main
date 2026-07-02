import 'mocha';

import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, FsBootsrapper, fsService } from './../src/index.js';
import '@spinajs/templates-pug';
import { dir, TestConfiguration } from './common.js';
import { expect } from 'chai';
import { join } from 'path';
import { IOFail } from '@spinajs/exceptions';
import { cp, rm } from 'fs/promises';
import { mkdirSync } from 'fs';

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

    await DI.resolve(fsService);

  });

  after(async () => {});

  beforeEach(async () => {
    try {
      await rm(join(dir('./files')), { recursive: true });
      await rm(join(dir('./files-2')), { recursive: true });
    } catch {}

    await cp(join(dir('./files_restore')), join(dir('./files')), { recursive: true, force: true });
    await mkdirSync(dir('./files-2'));
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

    const ex = await _f.exists('move-bewtween.txt');
    const ex2 = await _f2.exists('move-bewtween.txt');

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
    await _f.upload(_f.resolvePath('dir_zip'), 'dir_zip_uploaded');

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

    await _f.move('dir_zip', 'dir_zip', _f2);

    const e1 = await _f.exists('dir_zip');

    const exists = await _f2.exists('dir_zip');
    const isDir = await _f2.isDir('dir_zip');

    expect(e1).to.be.false;
    expect(exists).to.be.true;
    expect(isDir).to.be.true;
  });

  it('Should copy between fs', async () =>{ 
    const _f = await f();
    const _f2 = await f2();

    await _f.copy('dir_zip', 'dir_zip', _f2);

    const e1 = await _f.exists('dir_zip');

    const exists = await _f2.exists('dir_zip');
    const isDir = await _f2.isDir('dir_zip');

    expect(e1).to.be.true;
    expect(exists).to.be.true;
    expect(isDir).to.be.true;
  });

  it('should copy between fs', async () => {
    const _f = await f();
    const _f2 = await f2();

    await _f.write('copy-bewtween.txt', 'hello world', 'utf-8');
    await _f.copy('copy-bewtween.txt', 'move-bewtween.txt', _f2);

    const ex = await _f.exists('move-bewtween.txt');
    const ex2 = await _f2.exists('move-bewtween.txt');

    expect(ex).to.be.false;
    expect(ex2).to.be.true;
  });

  it('Should throw on copy and file not exists', async () => {
    const _f = await f();
    expect(_f.copy('not_exists.txt', 'not_exists_copy.txt')).to.be.rejectedWith(IOFail);
  });

  it('Should throw on move when not exists', async () => {
    const _f = await f();
    expect(_f.move('not_exists.txt', 'not_exists_copy.txt')).to.be.rejectedWith(IOFail);
  });

  it('should get file stats', async () => {
    const _f = await f();
    const result = await _f.stat('test.txt');
    expect(result).to.be.not.null;
  });

  it('should zip file', async () => {
    const _f = await f();
    const _tmp = await fTemp();
    const result = await _f.zip(['test.txt', 'test2.txt']);

    const exist = await _tmp.exists(result.asFilePath());
    expect(exist).to.be.true;
  });

 

  it('should unzip file', async () => {
    const _f = await f();

    await _f.unzip('zipped.zip', 'zipped');

    const exist = await _f.exists('zipped/zipped.txt');
    expect(exist).to.be.true;
  });

  it('Should zip dir', async () => {
    const _f = await f();
    const _tmp = await fTemp();
    const result = await _f.zip('dir_zip');

    const exist = await _tmp.exists(result.asFilePath());
    expect(exist).to.be.true;
  });

  it('Should unzip to another fs', async () => {
    const _f = await f();
    const _f2 = await f2();
    await _f.unzip('zipped.zip', 'zipped_dir', _f2);

    const exist = await _f2.exists('zipped_dir');
    const exist2 = await _f2.exists('zipped_dir/zipped.txt');
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

    expect(result.fs.Name).to.eq('fs-temp');
    const exist = await result.fs.exists(result.asFilePath());
    expect(exist).to.be.true;
  });

  it('should append to file relative to base path', async () => {
    const _f = await f();
    await _f.write('append.txt', 'hello', 'utf-8');
    await _f.append('append.txt', ' world', 'utf-8');

    // must resolve under provider base path, not process.cwd()
    const ex = await _f.exists('append.txt');
    expect(ex).to.be.true;

    const content = await _f.read('append.txt', 'utf-8');
    expect(content).to.eq('hello world');
  });

  it('should create file when appending to non existing file', async () => {
    const _f = await f();
    await _f.append('append-new.txt', 'created via append', 'utf-8');

    const content = await _f.read('append-new.txt', 'utf-8');
    expect(content).to.eq('created via append');
  });

  it('dirExists should be true for a directory and false for a file', async () => {
    const _f = await f();

    const dirOk = await _f.dirExists('dir_zip');
    const fileIsNotDir = await _f.dirExists('test.txt');
    const missing = await _f.dirExists('nope');

    expect(dirOk).to.be.true;
    expect(fileIsNotDir).to.be.false;
    expect(missing).to.be.false;
  });

  it('isDir should distinguish files from directories', async () => {
    const _f = await f();

    expect(await _f.isDir('dir_zip')).to.be.true;
    expect(await _f.isDir('test.txt')).to.be.false;
  });

  it('should rename a file', async () => {
    const _f = await f();
    await _f.write('rename-src.txt', 'data', 'utf-8');
    await _f.rename('rename-src.txt', 'rename-dst.txt');

    expect(await _f.exists('rename-src.txt')).to.be.false;
    expect(await _f.exists('rename-dst.txt')).to.be.true;
  });

  it('download should return local path for existing file', async () => {
    const _f = await f();
    const p = await _f.download('test.txt');
    expect(p).to.eq(_f.resolvePath('test.txt'));
  });

  it('download should reject when file does not exist', async () => {
    const _f = await f();
    await expect(_f.download('does-not-exist.txt')).to.be.rejectedWith(IOFail);
  });

  it('should upload a single local file', async () => {
    const _f = await f();
    const src = _f.resolvePath('test.txt');
    await _f.upload(src, 'uploaded.txt');

    expect(await _f.exists('uploaded.txt')).to.be.true;
    expect(await _f.read('uploaded.txt', 'utf-8')).to.eq('hello world');
  });

  it('should read a file via read stream', async () => {
    const _f = await f();
    const stream = await _f.readStream('test.txt', 'utf-8');

    const content: string = await new Promise((resolve, reject) => {
      let acc = '';
      stream.on('data', (chunk) => (acc += chunk.toString()));
      stream.on('end', () => resolve(acc));
      stream.on('error', reject);
    });

    expect(content).to.eq('hello world');
  });

  it('should write a file via write stream', async () => {
    const _f = await f();
    const stream = await _f.writeStream('ws.txt', 'utf-8');

    await new Promise<void>((resolve, reject) => {
      stream.on('finish', () => resolve());
      stream.on('error', reject);
      stream.end('stream content');
    });

    expect(await _f.read('ws.txt', 'utf-8')).to.eq('stream content');
  });

  it('should hash file through the fs facade', async () => {
    const _f = await f();
    const hash = await _f.hash('test.txt');
    expect(hash).to.eq('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('tmppath should point inside base path and be unique', async () => {
    const _f = await f();
    const a = _f.tmppath();
    const b = _f.tmppath();

    expect(a).to.not.eq(b);
    expect(a.startsWith(_f.resolvePath(''))).to.be.true;
  });

  it('resolvePath is idempotent for absolute paths inside base path', async () => {
    const _f = await f();
    const abs = _f.resolvePath('test.txt');
    expect(_f.resolvePath(abs)).to.eq(abs);
  });

  it('resolvePath must not treat sibling directories as already resolved', async () => {
    const _f = await f();
    const _f2 = await f2();

    // absolute path that lives in the OTHER provider's base dir (a sibling of
    // this provider's base dir sharing a name prefix, eg. files vs files-2)
    const siblingAbs = _f2.resolvePath('a.txt');
    const resolved = _f.resolvePath(siblingAbs);

    expect(resolved).to.not.eq(siblingAbs);
  });
});
