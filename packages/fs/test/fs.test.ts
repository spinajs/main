import 'mocha';
import { fsApp, FooFs } from './common.js';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import '@spinajs/templates-pug';
import { FileSystem } from '../src/decorators.js';
import { fs, fsService } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

describe('general fs tests', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    FooFs.INSTANCE_COUNT = 0;
    FooFs.INSTANCE_COUNT_2 = 0;
    app = await fsApp({ resolve: [fsService] });
  });

  after(async () => {
    await app.dispose();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should create only one instance of the same filesystem', async () => {
    DI.resolve<fs>('__file_provider__', ['foo1']);
    DI.resolve<fs>('__file_provider__', ['foo1']);
    DI.resolve<fs>('__file_provider__', ['foo1']);
    DI.resolve<fs>('__file_provider__', ['foo1']);

    expect(FooFs.INSTANCE_COUNT).to.equal(1);
  });

  it('Should create multiple instance of fs service with different name', async () => {
    DI.resolve<fs>('__file_provider__', ['foo1']);

    expect(FooFs.INSTANCE_COUNT).to.equal(1);

    DI.resolve<fs>('__file_provider__', ['foo2']);

    expect(FooFs.INSTANCE_COUNT_2).to.equal(1);

    const f1 = DI.resolve<fs>('__file_provider__', ['foo1']);
    const f2 = DI.resolve<fs>('__file_provider__', ['foo2']);
    expect(FooFs.INSTANCE_COUNT_2).to.equal(1);
    expect(FooFs.INSTANCE_COUNT).to.equal(1);

    expect(f1.Name).to.equal('foo1');
    expect(f2.Name).to.equal('foo2');
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
    expect(instance.Temp.ServiceName).to.eq('fs-temp');
  });
});
