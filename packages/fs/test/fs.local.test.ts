import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, FsBootsrapper } from '@spinajs/fs';
import '@spinajs/templates-pug';
import { TestConfiguration } from './common.js';



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

    it('should throw if base path not exists', async () =>{ 

    });

    it('should read file', async () =>{ 

    });

    it('should write to file', async () =>{ 

    });

    it('should delete file', async () =>{ 

    });

    it('should rename file', async () =>{ 

    });

    it('should get file stats', async () =>{ 

    });
     
});


