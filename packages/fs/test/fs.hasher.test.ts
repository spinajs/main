import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FsBootsrapper } from '@spinajs/fs';
import '@spinajs/templates-pug';
import { dir, TestConfiguration } from './common.js';
import { FileHasher, fsService } from '../src/index.js';
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

    it("Should hash with algo from options", async () =>{ 

    });
});