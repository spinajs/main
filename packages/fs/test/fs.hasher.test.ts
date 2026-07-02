import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import '@spinajs/templates-pug';
import { dir, TestConfiguration } from './common.js';
import { DefaultFileHasher, FileHasher, FsBootsrapper, fsService } from '../src/index.js';
import { IOFail } from '@spinajs/exceptions';
import { Readable } from 'stream';

const SHA256_HELLO_WORLD = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
const MD5_HELLO_WORLD = '5eb63bbbe01eeed093cb22bb8f5acdc3';
const SHA1_HELLO_WORLD = '2aae6c35c94fcfb415dbe95f408b9ce91ee846ed';



describe('fs hasher tests', function () {
    this.timeout(15000);

    before(async () => {
        const bootstrapper = DI.resolve(FsBootsrapper);
        bootstrapper.bootstrap();

        DI.register(TestConfiguration).as(Configuration);
        await DI.resolve(Configuration);

        await DI.resolve(fsService);

    });

    after(async () => {
    });

    afterEach(() => {
        sinon.restore();
    });

    it('Should register file info service in DI container', async () => {
        expect(DI.check(FileHasher)).to.be.true;
    });

    it('should throw path not exists', async () => {
        const fInfo = await DI.resolve(FileHasher);
        expect(fInfo.hash("someFile.txt")).to.be.rejectedWith(IOFail, "File someFile.txt not exists")
    });

    it('Should hash sample file', async () => {
        const fInfo = await DI.resolve(FileHasher);
        const result = await fInfo.hash(dir("sample-files/test.txt"));

        expect(result).to.be.not.null;
        expect(result).to.be.not.undefined;
        expect(result).to.eq("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    });

    it("Should hash with algo from options", async () => {
        // resolve default (sha256) first so a sha256 instance exists in the container
        const sha = await DI.resolve<FileHasher>(FileHasher);
        const shaResult = await sha.hash(dir("sample-files/test.txt"));
        expect(shaResult).to.eq("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");

        // requesting a different algorithm must resolve a distinct instance and hash accordingly,
        // not reuse the cached sha256 hasher
        const md5 = await DI.resolve<FileHasher>(FileHasher, ['md5']);
        const md5Result = await md5.hash(dir("sample-files/test.txt"));

        expect(md5).to.not.eq(sha);
        // md5 of 'hello world'
        expect(md5Result).to.eq(MD5_HELLO_WORLD);
    });

    it('should hash a file with a base64 output encoding', async () => {
        const hasher = await DI.resolve<FileHasher>(FileHasher);
        const result = await hasher.hash(dir('sample-files/test.txt'), 'base64');

        const expected = Buffer.from(SHA256_HELLO_WORLD, 'hex').toString('base64');
        expect(result).to.eq(expected);
    });

    it('hashData hashes an in-memory string', async () => {
        const hasher = await DI.resolve<FileHasher>(FileHasher);
        const result = await hasher.hashData('hello world');
        expect(result).to.eq(SHA256_HELLO_WORLD);
    });

    it('hashData hashes an in-memory Buffer', async () => {
        const hasher = await DI.resolve<FileHasher>(FileHasher);
        const result = await hasher.hashData(Buffer.from('hello world', 'utf-8'));
        expect(result).to.eq(SHA256_HELLO_WORLD);
    });

    it('hashData respects the output encoding', async () => {
        const hasher = await DI.resolve<FileHasher>(FileHasher);
        const result = await hasher.hashData('hello world', 'base64');
        expect(result).to.eq(Buffer.from(SHA256_HELLO_WORLD, 'hex').toString('base64'));
    });

    it('hashStream hashes the content of a readable stream', async () => {
        const hasher = await DI.resolve<FileHasher>(FileHasher);
        const result = await hasher.hashStream(Readable.from(['hello ', 'world']));
        expect(result).to.eq(SHA256_HELLO_WORLD);
    });

    it('should reject with IOFail for an unsupported algorithm', async () => {
        const hasher = await DI.resolve<FileHasher>(FileHasher, ['not-a-real-algo']);
        await expect(hasher.hash(dir('sample-files/test.txt'))).to.be.rejectedWith(IOFail, 'Unsupported hash algorithm');
        await expect(hasher.hashData('x')).to.be.rejectedWith(IOFail, 'Unsupported hash algorithm');
    });

    it('should use the default algorithm configured in fs.hasher.defaultAlgorithm', async () => {
        const config = DI.get(Configuration) as any;
        // @Config getter calls config.get(path, defaultValue) - match by path only, delegate the rest
        const original = config.get.bind(config);
        sinon.stub(config, 'get').callsFake((path: string, def?: unknown) =>
            path === 'fs.hasher.defaultAlgorithm' ? 'sha1' : original(path, def),
        );

        // constructed directly to bypass the per-instance cache and read config at build time
        const hasher = new DefaultFileHasher();
        expect(hasher.Algorithm).to.eq('sha1');

        const result = await hasher.hash(dir('sample-files/test.txt'));
        expect(result).to.eq(SHA1_HELLO_WORLD);
    });
});