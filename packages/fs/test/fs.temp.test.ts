import 'mocha';
//import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FsBootsrapper } from '@spinajs/fs';
import '@spinajs/templates-pug';
import { TestConfiguration } from './common.js';
import { fs } from '../src/index.js';

import { existsSync } from 'fs';
import { expect } from 'chai';

async function tmp() {
    return await DI.resolve<fs>('__file_provider__', ['fs-temp']);
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
        const t = await tmp();
        await t.dispose();
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should create temporary file', async () => {

        const t = await tmp();
        await t.write("tmp.txt", "hello temp");

        const tExists = await t.exists("tmp.txt");
        const fsExists = existsSync(t.resolvePath("tmp.txt"));
        const tmpPath = t.resolvePath("tmp.txt");

        expect(tExists).to.be.true;
        expect(fsExists).to.be.true;
        expect(tmpPath.endsWith('packages\\fs\\test\\temp\\tmp.txt')).to.true;
    });

    it('should cleanup old temp file', async () => {

    })





});


