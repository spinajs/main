import 'mocha';

import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, FsBootsrapper, fsService } from './../src/index.js';
import '@spinajs/templates-pug';
import { dir, TestConfiguration } from './common.js';
import { expect } from 'chai';
import { isAbsolute, join } from 'path';
import { IOFail } from '@spinajs/exceptions';
import { cp, rm } from 'fs/promises';
import { mkdirSync } from 'fs';
import { PassThrough } from 'stream';

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
    await expect(_f.copy('not_exists.txt', 'not_exists_copy.txt')).to.be.rejectedWith(IOFail);
  });

  it('Should throw on move when not exists', async () => {
    const _f = await f();
    await expect(_f.move('not_exists.txt', 'not_exists_copy.txt')).to.be.rejectedWith(IOFail);
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

  it('zip result accessors must not depend on process.cwd()', async () => {
    const _f = await f();
    const result = await _f.zip(['test.txt']);

    // asFilePath returns a path resolved against the destination fs
    expect(isAbsolute(result.asFilePath())).to.be.true;

    // asBase64 / asStream read the actual zip content ( 'PK' magic bytes )
    const b64 = result.asBase64();
    expect(b64.length).to.be.greaterThan(0);
    expect(Buffer.from(b64, 'base64').subarray(0, 2).toString('ascii')).to.eq('PK');

    const stream = result.asStream();
    const first: Buffer = await new Promise((resolve, reject) => {
      stream.once('data', (chunk) => {
        stream.destroy();
        resolve(chunk as Buffer);
      });
      stream.once('error', reject);
    });
    expect(first.subarray(0, 2).toString('ascii')).to.eq('PK');

    await result.unlink();
  });

  it('writeStream should pipe any readable stream, not only fs.ReadStream', async () => {
    const _f = await f();

    const source = new PassThrough();
    const wStream = await _f.writeStream('piped.txt', source);

    const done = new Promise<void>((resolve, reject) => {
      wStream.on('finish', () => resolve());
      wStream.on('error', reject);
    });

    source.end('piped content');
    await done;

    expect(await _f.read('piped.txt', 'utf-8')).to.eq('piped content');
  });

  it('read without encoding should return a Buffer', async () => {
    const _f = await f();
    const data = await _f.read('test.txt');

    expect(Buffer.isBuffer(data)).to.be.true;
    expect((data as Buffer).toString('utf-8')).to.eq('hello world');
  });

  it('stat should report a sane creation time for fresh files', async () => {
    const _f = await f();
    await _f.write('fresh.txt', 'x', 'utf-8');

    const s = await _f.stat('fresh.txt');
    expect(s.CreationTime?.isValid).to.be.true;

    const ageSeconds = Math.abs(s.CreationTime!.diffNow('seconds').seconds);
    expect(ageSeconds).to.be.lessThan(60);
  });

  it('resolvePath must not treat sibling directories as already resolved', async () => {
    const _f = await f();
    const _f2 = await f2();

    // absolute path that lives in the OTHER provider's base dir (a sibling of
    // this provider's base dir sharing a name prefix, eg. files vs files-2).
    // With sandboxing it must be rejected, not silently joined.
    const siblingAbs = _f2.resolvePath('a.txt');
    expect(() => _f.resolvePath(siblingAbs)).to.throw(IOFail);
  });

  it('resolvePath rejects relative paths escaping base path', async () => {
    const _f = await f();

    expect(() => _f.resolvePath('../escape.txt')).to.throw(IOFail);
    expect(() => _f.resolvePath('a/../../escape.txt')).to.throw(IOFail);
    expect(() => _f.resolvePath('..')).to.throw(IOFail);
  });

  it('resolvePath allows paths inside base, including harmless dots', async () => {
    const _f = await f();

    expect(_f.resolvePath('.')).to.eq(_f.resolvePath(''));
    expect(_f.resolvePath('a/../b.txt')).to.eq(_f.resolvePath('b.txt'));
  });

  it('exists returns false for paths escaping base path', async () => {
    const _f = await f();
    expect(await _f.exists('../fs.local.test.ts')).to.be.false;
  });

  it('read/stat/list on missing paths reject with IOFail', async () => {
    const _f = await f();

    await expect(_f.read('missing.txt', 'utf-8')).to.be.rejectedWith(IOFail);
    await expect(_f.stat('missing.txt')).to.be.rejectedWith(IOFail);
    await expect(_f.list('missing-dir')).to.be.rejectedWith(IOFail);
    await expect(_f.readStream('missing.txt')).to.be.rejectedWith(IOFail);
    await expect(_f.rename('missing.txt', 'x.txt')).to.be.rejectedWith(IOFail);
  });

  it('unzip rejects with IOFail when source zip does not exist ( no crash )', async () => {
    const _f = await f();
    await expect(_f.unzip('no-such.zip', 'out-dir')).to.be.rejectedWith(IOFail);
  });

  it('unzip rejects with IOFail on a corrupt zip', async () => {
    const _f = await f();
    await _f.write('corrupt.zip', 'this is not a zip file', 'utf-8');
    await expect(_f.unzip('corrupt.zip', 'corrupt-out')).to.be.rejectedWith(IOFail);
  });

  it('zip pre-validates source paths and rejects listing the missing ones', async () => {
    const _f = await f();
    await expect(_f.zip(['test.txt', 'nope-1.txt', 'nope-2.txt'])).to.be.rejectedWith(IOFail, /nope-1\.txt.*nope-2\.txt/);
  });

  it('writeStream propagates source stream errors instead of hanging', async () => {
    const _f = await f();

    const source = new PassThrough();
    const wStream = await _f.writeStream('stream-err.txt', source);

    const failure = new Promise<Error>((resolve) => wStream.on('error', resolve));
    source.emit('error', new Error('source blew up'));

    const err = await failure;
    expect(err.message).to.contain('source blew up');
  });

  it('move falls back to copy+delete on EXDEV ( cross device )', async () => {
    const _f = await f();
    await _f.write('exdev-src.txt', 'cross device', 'utf-8');

    // simulate a cross-device rename failure
    const stub = sinon.stub(_f as any, '_rename').rejects(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));

    try {
      await _f.move('exdev-src.txt', 'exdev-dst.txt');
    } finally {
      stub.restore();
    }

    expect(await _f.exists('exdev-src.txt')).to.be.false;
    expect(await _f.read('exdev-dst.txt', 'utf-8')).to.eq('cross device');
  });

  it('move creates missing destination directories', async () => {
    const _f = await f();
    await _f.write('move-nested-src.txt', 'nested', 'utf-8');

    await _f.move('move-nested-src.txt', 'nested/deep/move-dst.txt');

    expect(await _f.read('nested/deep/move-dst.txt', 'utf-8')).to.eq('nested');
  });

  it('stat mapper falls back to mtime when birthtime is unsupported ( epoch 0 )', async () => {
    const _f = await f();
    const mtime = new Date('2024-06-01T12:00:00Z');

    const entry = (_f as any).toStatEntry({
      isDirectory: () => false,
      isFile: () => true,
      birthtime: new Date(0),
      mtime,
      atime: mtime,
      size: 42,
    });

    expect(entry.CreationTime.toJSDate().getTime()).to.eq(mtime.getTime());
    expect(entry.Size).to.eq(42);
  });

  it('resolve() canonicalizes a relative base path', async () => {
    const { fsNative } = await import('../src/local-provider.js');
    const provider = new fsNative({ name: 'rel-base-test', basePath: 'test/rel-base-tmp' });

    try {
      await provider.resolve();
      expect(isAbsolute(provider.Options.basePath!)).to.be.true;
      expect(await provider.isDir(provider.Options.basePath!)).to.be.true;
    } finally {
      await rm(provider.Options.basePath!, { recursive: true, force: true });
    }
  });
});
