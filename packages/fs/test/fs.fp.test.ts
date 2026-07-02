import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FsBootsrapper, fs, fsService, IZipResult } from '../src/index.js';
import { fsNative } from '../src/local-provider.js';
import {
  _exists,
  _read_file,
  _file_hash,
  _is_of_type,
  _is_of_mimetype,
  _fs,
  _zip,
  _write,
  _read,
  _append,
  _copy,
  _move,
  _rename,
  _rm,
  _mkdir,
  _list,
  _stat,
  _dir_exists,
  _is_dir,
  _download,
  _upload,
  _hash,
} from '../src/fp.js';
import { dir, TestConfiguration } from './common.js';
import { IOFail } from '@spinajs/exceptions';

describe('fs fp helpers', function () {
  this.timeout(15000);

  before(async () => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);

    await DI.resolve(fsService);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('_fs resolves a registered provider', () => {
    const f = _fs('fs-temp')();
    expect(f).to.not.be.undefined;
    expect(f!.Name).to.eq('fs-temp');
  });

  it('_fs returns undefined for a falsy name', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(_fs(undefined as any)()).to.be.undefined;
  });

  it('_fs passes an fs instance through unchanged', () => {
    // a value that is an instanceof fs must be returned as-is, not re-resolved by name
    const instance = new fsNative({ name: 'passthrough', basePath: dir('files') });
    expect(_fs(instance)()).to.eq(instance);
  });

  it('_exists reflects presence of a file', async () => {
    expect(await _exists(dir('sample-files/test.txt'))()).to.be.true;
    expect(await _exists(dir('sample-files/does-not-exist.txt'))()).to.be.false;
  });

  it('_read_file reads file content', async () => {
    const buf = await _read_file(dir('sample-files/test.txt'))();
    expect(buf.toString('utf-8')).to.eq('hello world');
  });

  it('_file_hash returns the sha256 of a file', async () => {
    const hash = await _file_hash(dir('sample-files/test.txt'));
    expect(hash).to.eq('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('_is_of_type accepts a matching extension and rejects a mismatch', async () => {
    await _is_of_type(dir('sample-files/SamplePNGImage_100kbmb.png'), 'png')();
    await expect(_is_of_type(dir('sample-files/SamplePNGImage_100kbmb.png'), 'jpg')()).to.be.rejectedWith(IOFail);
  });

  it('_is_of_mimetype accepts a matching mime and rejects a mismatch', async () => {
    await _is_of_mimetype(dir('sample-files/SamplePNGImage_100kbmb.png'), 'image/png')();
    await expect(_is_of_mimetype(dir('sample-files/SamplePNGImage_100kbmb.png'), 'image/jpeg')()).to.be.rejectedWith(IOFail);
  });

  it('_zip falls back to the temp fs when no source fs is provided', async () => {
    const tmp = await DI.resolve<fs>('__file_provider__', ['fs-temp']);
    await tmp.write('fp-src.txt', 'zip me', 'utf-8');

    const result = (await _zip(['fp-src.txt'], 'fp-out.zip')) as IZipResult;

    expect(result.fs.Name).to.eq('fs-temp');
    expect(await result.fs.exists(result.asFilePath())).to.be.true;
  });

  describe('provider-aware actions', () => {
    before(async () => {
      // local provider write() does not create parent dirs - ensure the working dir exists
      await _mkdir('fp', 'test');
    });

    it('_write then _read round trips through a named provider', async () => {
      await _write('fp/write.txt', 'hello fp', 'utf-8', 'test');
      const content = await _read('fp/write.txt', 'utf-8', 'test');
      expect(content).to.eq('hello fp');
    });

    it('_read without encoding returns a Buffer', async () => {
      await _write('fp/buffer.txt', 'raw', 'utf-8', 'test');
      const content = await _read('fp/buffer.txt', undefined, 'test');
      expect(Buffer.isBuffer(content)).to.be.true;
    });

    it('_append appends to a file', async () => {
      await _write('fp/append.txt', 'a', 'utf-8', 'test');
      await _append('fp/append.txt', 'b', 'utf-8', 'test');
      expect(await _read('fp/append.txt', 'utf-8', 'test')).to.eq('ab');
    });

    it('_exists with a provider reflects presence', async () => {
      await _write('fp/exists.txt', 'x', 'utf-8', 'test');
      expect(await _exists('fp/exists.txt', 'test')()).to.be.true;
      expect(await _exists('fp/missing.txt', 'test')()).to.be.false;
    });

    it('_mkdir, _dir_exists and _is_dir work together', async () => {
      await _mkdir('fp/subdir', 'test');
      expect(await _dir_exists('fp/subdir', 'test')).to.be.true;
      expect(await _is_dir('fp/subdir', 'test')).to.be.true;

      await _write('fp/file.txt', 'x', 'utf-8', 'test');
      expect(await _is_dir('fp/file.txt', 'test')).to.be.false;
    });

    it('_list returns directory entries', async () => {
      await _mkdir('fp/listdir', 'test');
      await _write('fp/listdir/a.txt', 'a', 'utf-8', 'test');
      await _write('fp/listdir/b.txt', 'b', 'utf-8', 'test');

      const entries = await _list('fp/listdir', 'test');
      expect(entries).to.include.members(['a.txt', 'b.txt']);
    });

    it('_stat returns file statistics', async () => {
      await _write('fp/stat.txt', 'stat me', 'utf-8', 'test');
      const stat = await _stat('fp/stat.txt', 'test');
      expect(stat.IsFile).to.be.true;
      expect(stat.Size).to.be.greaterThan(0);
    });

    it('_copy copies within a provider', async () => {
      await _write('fp/copy-src.txt', 'copy', 'utf-8', 'test');
      await _copy('fp/copy-src.txt', 'fp/copy-dst.txt', 'test');
      expect(await _exists('fp/copy-dst.txt', 'test')()).to.be.true;
    });

    it('_copy copies across providers', async () => {
      await _write('fp/cross.txt', 'cross', 'utf-8', 'test');
      await _copy('fp/cross.txt', 'fp-cross.txt', 'test', 'test-2');
      expect(await _exists('fp-cross.txt', 'test-2')()).to.be.true;
    });

    it('_move moves a file', async () => {
      await _write('fp/move-src.txt', 'move', 'utf-8', 'test');
      await _move('fp/move-src.txt', 'fp/move-dst.txt', 'test');
      expect(await _exists('fp/move-src.txt', 'test')()).to.be.false;
      expect(await _exists('fp/move-dst.txt', 'test')()).to.be.true;
    });

    it('_rename renames a file', async () => {
      await _write('fp/rename-src.txt', 'rename', 'utf-8', 'test');
      await _rename('fp/rename-src.txt', 'fp/rename-dst.txt', 'test');
      expect(await _exists('fp/rename-src.txt', 'test')()).to.be.false;
      expect(await _exists('fp/rename-dst.txt', 'test')()).to.be.true;
    });

    it('_rm removes a file', async () => {
      await _write('fp/rm.txt', 'rm', 'utf-8', 'test');
      await _rm('fp/rm.txt', 'test');
      expect(await _exists('fp/rm.txt', 'test')()).to.be.false;
    });

    it('_download returns the local path', async () => {
      await _write('fp/download.txt', 'dl', 'utf-8', 'test');
      const local = await _download('fp/download.txt', 'test');
      const provider = _fs('test')();
      expect(local).to.eq(provider!.resolvePath('fp/download.txt'));
    });

    it('_upload uploads a local file into a provider', async () => {
      await _upload(dir('sample-files/test.txt'), 'fp/uploaded.txt', 'test');
      expect(await _read('fp/uploaded.txt', 'utf-8', 'test')).to.eq('hello world');
    });

    it('_hash hashes a file through a provider', async () => {
      await _write('fp/hash.txt', 'hello world', 'utf-8', 'test');
      const hash = await _hash('fp/hash.txt', undefined, 'test');
      expect(hash).to.eq('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });

    it('provider actions fall back to the configured default provider', async () => {
      // TestConfiguration sets fs.defaultProvider = 'test'. No fs arg -> default provider.
      await _write('fp/default.txt', 'default', 'utf-8');
      expect(await _read('fp/default.txt', 'utf-8')).to.eq('default');

      // _exists without a provider is a LOCAL check by design; use _stat for the provider path
      const stat = await _stat('fp/default.txt');
      expect(stat.IsFile).to.be.true;
    });
  });
});
