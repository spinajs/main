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
        expect(async () => {
            await fInfo.getInfo("someFile.txt");
        }).to.throw("Path someFile.txt not exists")
    });

    it('Should return basic file properties', async () => {
        const fInfo = await DI.resolve(FileInfoService);
        const result = await fInfo.getInfo(dir("sample-files/test.txt"));

        expect(result).to.be.not.null;
        expect(result).to.be.not.undefined;
        expect(result).to.include({
            Size: 0,
            Height: 0,
            Width: 0,
            Duration: 0,
            FrameCount: 0,
            FrameRate: 0,
            Bitrate: 0,
            Codec: null,
            Compressor: null,
        })
    });

    it('Should return movie properties', async () => {

    });

    it('Should return image properties', async () => {

    });


});