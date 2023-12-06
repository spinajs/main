import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, FsBootsrapper } from '@spinajs/fs';
import '@spinajs/templates-pug';
import { TestConfiguration } from './common.js';
import { FileSystem } from '../src/decorators.js';

describe('fp fs tests', function () {
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

    it('should resolve filesystem', () =>{ 


    });

    it('should read file', () =>{ 

    });

    it('should read file from system fs', () =>{ 

    });

    it('should copy file', () =>{ 

    });

    it('should should copy file from system fs', () =>{ 

    });

    it('Should delete all files', () =>{ 

    });

    it("Should copy all files", () =>{ 

    });

    it("Should copy all files with errors", () =>{ 

    });
})