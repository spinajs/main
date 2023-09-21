import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FsBootsrapper } from '@spinajs/fs';
import '@spinajs/templates-pug';
import { dir, TestConfiguration } from './common.js';
import { FileInfoService } from '../src/index.js';



describe('fs temp tests', function () {
    this.timeout(15000);

    before(async () => {
        const bootstrapper = DI.resolve(FsBootsrapper);
        bootstrapper.bootstrap();

        DI.register(TestConfiguration).as(Configuration);
        await DI.resolve(Configuration);
    });

    after(async () => {
    });

    afterEach(() => {
        sinon.restore();
    });

    it('Should register file info service in DI container', async () => {
        expect(DI.check(FileInfoService)).to.be.true;
    });

    it('should throw path not exists', async () => {
        const fInfo = await DI.resolve(FileInfoService);
        expect(fInfo.getInfo("someFile.txt")).to.be.rejectedWith("Path someFile.txt not exists")
    });

    it('Should return basic file properties', async () => {
        const fInfo = await DI.resolve(FileInfoService);
        const result = await fInfo.getInfo(dir("sample-files/test.txt"));

        expect(result).to.be.not.null;
        expect(result).to.be.not.undefined;
        expect(result).to.include({
            FileSize: 11,
            MimeType: "text/plain"
        })
    });

    it('Should return movie properties', async () => {
        const fInfo = await DI.resolve(FileInfoService);
        const result = await fInfo.getInfo(dir("sample-files/sample-5s.mp4"));

        expect(result).to.be.not.null;
        expect(result).to.be.not.undefined;
        expect(result).to.include({
            FileSize: 2848208,
            MimeType: "video/mp4",
            Duration: 5.759,
            Width: 1920,
            Height: 1080,
            AudioChannels: 2
        });
    });

    it('Should return image properties', async () => {
        const fInfo = await DI.resolve(FileInfoService);
        const result = await fInfo.getInfo(dir("sample-files/SamplePNGImage_100kbmb.png"));

        expect(result).to.be.not.null;
        expect(result).to.be.not.undefined;
        expect(result).to.include({
            FileSize: 104327,
            MimeType: "image/png",
            Width: 272,
            Height: 170,
        })
    });


});