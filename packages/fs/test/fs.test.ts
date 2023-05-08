import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, FsBootsrapper } from '@spinajs/fs';
import '@spinajs/templates-pug';
import { TestConfiguration } from './common.js';
import { FileSystem } from '../src/decorators.js';



describe('general fs tests', function () {
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

    it('should create only one instance of the same filesystem', async () =>{ 

    });

    it('should create multiple filesystems at startup', async () => {


        const fs1 = DI.resolve<fs>('__file_provider__', ['test']);
        const fs2 = DI.resolve<fs>('__file_provider__', ['fs-temp']);

        expect(fs1).to.be.not.null;
        expect(fs2).to.be.not.null;

        expect(fs1.ServiceName).to.eq('test');
        expect(fs2.ServiceName).to.eq('fs-temp');

    });

    it('should inject filesystem via decorator', async () => {
        class Foo {
            @FileSystem('fs-temp')
            public Temp: fs;
        }

        const instance = await DI.resolve(Foo);

        expect(instance.Temp).to.be.not.null;
        expect(instance.Temp.ServiceName).to.eq('fs-temp')
    });
});


