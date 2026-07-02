import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import '@spinajs/templates-pug';
import { spawn } from 'node:child_process';
import { dir, TestConfiguration } from './common.js';
import { FileInfoService, FsBootsrapper, fsService, resolveExifToolPath } from '../src/index.js';

function exiftoolAvailable(binary: string): Promise<boolean> {
    return new Promise((resolve) => {
        const p = spawn(binary, ['-ver']);
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
    });
}

describe('fs fileinfo tests', function () {
    this.timeout(15000);

    before(async function () {
        const bootstrapper = DI.resolve(FsBootsrapper);
        bootstrapper.bootstrap();

        DI.register(TestConfiguration).as(Configuration);
        await DI.resolve(Configuration);

        await DI.resolve(fsService);

        // vendored exiftool should make these tests runnable everywhere. If the
        // binary is still not resolvable, skip on windows only - on linux ( CI )
        // run and fail loudly so a broken exiftool setup is not silently ignored.
        const available = await exiftoolAvailable(await resolveExifToolPath());
        if (!available && process.platform === 'win32') {
            this.skip();
        }
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
            FileSize: 11
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