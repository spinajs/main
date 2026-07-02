import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import '@spinajs/templates-pug';
import { dir, TestConfiguration } from './common.js';
import { FileHasher, FsBootsrapper, fsService } from '../src/index.js';
import { IOFail } from '@spinajs/exceptions';



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
        expect(md5Result).to.eq("5eb63bbbe01eeed093cb22bb8f5acdc3");
    });
});