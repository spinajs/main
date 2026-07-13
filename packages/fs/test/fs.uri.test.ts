import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FsBootsrapper, fs, fsService, URI } from '../src/index.js';
import { TestConfiguration } from './common.js';
import { InvalidArgument } from '@spinajs/exceptions';

describe('fs URI & static facade', function () {
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

  it('parses a valid fs:// uri', () => {
    const uri = new URI('fs://test/some/path/file.txt');
    expect(uri.Fs.Name).to.eq('test');
    expect(uri.Path).to.eq('some/path/file.txt');
  });

  it('parses a single segment path', () => {
    const uri = new URI('fs://test/file.txt');
    expect(uri.Fs.Name).to.eq('test');
    expect(uri.Path).to.eq('file.txt');
  });

  it('throws on malformed uri', () => {
    expect(() => new URI('not-a-valid-uri')).to.throw(InvalidArgument);
  });

  it('rejects sloppy schemes previously accepted by the regex', () => {
    expect(() => new URI('fsss://test/file.txt')).to.throw(InvalidArgument);
  });

  it('parses fs://name without a path as empty path', () => {
    const uri = new URI('fs://test');
    expect(uri.Fs.Name).to.eq('test');
    expect(uri.Path).to.eq('');
  });

  it('throws when filesystem is not registered', () => {
    // the DI provider factory rejects the unknown name before URI's own guard runs
    expect(() => new URI('fs://does-not-exist/file.txt')).to.throw(/not registered/);
  });

  it('writes, reads and checks existence through static methods', async () => {
    const src = new URI('fs://test/uri-write.txt');

    await fs.write(src, 'uri hello', 'utf-8');

    expect(await fs.exists(src)).to.be.true;
    expect(await fs.read(src, 'utf-8')).to.eq('uri hello');

    const stat = await fs.stat(src);
    expect(stat.IsFile).to.be.true;
  });

  it('copies a file across filesystems through static copy', async () => {
    const src = new URI('fs://test/uri-copy-src.txt');
    const dst = new URI('fs://test-2/uri-copy-dst.txt');

    await fs.write(src, 'across fs', 'utf-8');
    await fs.copy(src, dst);

    expect(await fs.exists(dst)).to.be.true;
    expect(await fs.read(dst, 'utf-8')).to.eq('across fs');
  });

  it('appends through static append', async () => {
    const src = new URI('fs://test/uri-append.txt');

    await fs.write(src, 'a', 'utf-8');
    await fs.append(src, 'b', 'utf-8');

    expect(await fs.read(src, 'utf-8')).to.eq('ab');
  });

  it('renames through static rename with a string destination', async () => {
    const src = new URI('fs://test/uri-rename-src.txt');

    await fs.write(src, 'rename me', 'utf-8');
    await fs.rename(src, 'uri-rename-dst.txt');

    expect(await fs.exists(src)).to.be.false;
    expect(await fs.exists(new URI('fs://test/uri-rename-dst.txt'))).to.be.true;
  });

  it('removes through static rm', async () => {
    const src = new URI('fs://test/uri-rm.txt');

    await fs.write(src, 'delete me', 'utf-8');
    expect(await fs.exists(src)).to.be.true;

    await fs.rm(src);
    expect(await fs.exists(src)).to.be.false;
  });

  it('returns a temp path for a registered provider', () => {
    const p = fs.tmppath('fs-temp');
    expect(p).to.be.a('string');
    expect(p.length).to.be.greaterThan(0);
  });

  it('throws for tmppath on an unknown provider', () => {
    // resolving the unknown provider throws before the static tmppath IOFail guard
    expect(() => fs.tmppath('nope')).to.throw(/not registered/);
  });
});
