import 'mocha';

import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, FsBootsrapper } from '@spinajs/fs';
import '@spinajs/templates-pug';
import { TestConfiguration } from './common.js';
import { expect } from 'chai';


async function f() {
    return await DI.resolve<fs>('__file_provider__', ['test']);
}

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

    it('Should list files in dir', async () => {

        const _f = await f();

        const files = await _f.list("/");

        expect(files.length).to.be.gte(2);
        expect(files).to.include.members(['SamplePNGImage_100kbmb.png', 'test.txt']);

    });

    it('should read file', async () => {
        const _f = await f();

        const r = await _f.read("test.txt", "utf-8");
        expect(r).to.eq("hello world");
    });

    it('should write to file', async () => {

    });

    it('should delete file', async () => {

    });

    it('should rename file', async () => {

    });

    it('should get file stats', async () => {

    });

    it('should zip file', async () => {

    });

    it('should unzip file', async () => {

    });

});


