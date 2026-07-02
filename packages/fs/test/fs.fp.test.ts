import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FsBootsrapper, fs, fsService, IZipResult } from '../src/index.js';
import { fsNative } from '../src/local-provider.js';
import { _exists, _read_file, _file_hash, _is_of_type, _is_of_mimetype, _fs, _zip } from '../src/fp.js';
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
});
