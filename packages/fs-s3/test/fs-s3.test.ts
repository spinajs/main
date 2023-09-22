import 'mocha';

import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, FsBootsrapper } from '@spinajs/fs';
import "./../src/index.js"
import '@spinajs/templates-pug';
import { TestConfiguration } from './common.js';
import { expect } from 'chai';
import { fsS3 } from './../src/index.js';

async function f() {
    return await DI.resolve<fs>('__file_provider__', ['aws']);
}

async function fl() {
    return await DI.resolve<fs>('__file_provider__', ['test']);
}

describe('fs s3 basic tests', function () {
    this.timeout(65000);

    before(async () => {
        const bootstrapper = DI.resolve(FsBootsrapper);
        bootstrapper.bootstrap();

        DI.register(TestConfiguration).as(Configuration);
        await DI.resolve(Configuration);
    });

    after(async () => {

        const f3 = await f();
        await f3.rm("test.txt");
        await f3.rm("Big_Buck_Bunny_1080_10s_30MB.mp4");

    });

    afterEach(() => {
        sinon.restore();
    });

    it('Should register in di container', () => {
        const registered = DI.checkType(fs, fsS3);
        expect(registered).to.be.true;
    })

    it('should check if exists', async () => {
        const f3 = await f();
        const exists = await f3.exists("nonExists.txt");
        expect(exists).to.be.false;
    });

    it('should upload file', async () => {

        const f3 = await f();
        await f3.write("test.txt", "hello world");
        const exists = await f3.exists("test.txt");
        expect(exists).to.be.true;
    })

    it('should read file', async () => {

        const f3 = await f();
        const content = await f3.read("test.txt");

        expect(content).to.eq("hello world");

    })

    it('Should download file', async () => {

    })

    it('Should readable stream work', async () => {

    });

    it('should delete file', async () => {
        const f3 = await f();
        await f3.rm("test.txt");

        const exists = await f3.exists("test.txt");
        expect(exists).to.be.false;
    });

    it('should upload big file', async () => {
        const f3 = await f();
        const fLocal = await fl();

        const rStream = await fLocal.readStream("Big_Buck_Bunny_1080_10s_30MB.mp4", "binary");

        await f3.writeStream("Big_Buck_Bunny_1080_10s_30MB.mp4", rStream, "binary");

        const ex = await f3.exists("Big_Buck_Bunny_1080_10s_30MB.mp4");
        expect(ex).to.be.true;
    });

    it('should download file', async () => {

    });


});
