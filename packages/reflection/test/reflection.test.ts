/* eslint-disable @typescript-eslint/await-thenable */
/* eslint-disable @typescript-eslint/no-floating-promises */
import {  ResolveFromFiles } from './../src/index.js';
import { FrameworkConfiguration, Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import _ from 'lodash';
import 'mocha';
import { join, normalize, resolve } from 'path';
import { FooService } from './test-services/singletons/FooService.js';
import { SomeMatcher1TestClass } from './test-services/matcher/SomeMatcher1.js';

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

const expect = chai.expect;
chai.use(chaiAsPromised);
chai.use(chaiSubset);

 

export class MockCfg extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      system: {
        dirs: {
          singletons: [dir('./test-services/singletons')],
          alwaysnew: [dir('./test-services/alwaysnew')],
          async: [dir('./test-services/async')],
          throw: [dir('./test-services/throw')],
          mixed: [dir('./test-services/mixed')],
          throwasync: [dir('./test-services/throwasync')],
          empty: [dir('./test-services/empty')],
          matcher: [dir('./test-services/matcher')],
          multiple: [dir('./test-services/multiple')],
        },
      },
      logger: {
        variables: [],
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
          },
        ],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

describe('Reflection tests', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(MockCfg).as(Configuration);

    await DI.resolve(Configuration);
    FooService.Counter = 0;
  });

  // it('build', () => {
  //   build();
  // });

  it('Should load services', async () => {
    const target = {
      services: [] as any[],
    };

    ResolveFromFiles('/**/*.{ts,js}', 'system.dirs.singletons')(target, 'services');

    // eslint-disable-next-line @typescript-eslint/await-thenable
    const services = await target.services;

    expect(services).to.be.not.null;
    expect(services).to.be.an('array').that.have.length(2);
    expect(services[0])
      .to.include({
        name: 'FooService',
      })
      .and.to.have.property('instance').not.null;
  });

  it('Should load services with type matcher', async () => {
    const target = {
      services: [] as any[],
    };

    ResolveFromFiles('/**/*.{ts,js}', 'system.dirs.matcher', (file) => {
      return `${file}TestClass`;
    })(target, 'services');

    const services = await target.services;
    const cache = DI.RootContainer.Cache;

    expect(services).to.be.an('array').that.have.length(1);
    expect(cache.get('SomeMatcher1TestClass')).to.not.null;

    expect(DI.resolve(SomeMatcher1TestClass)).to.be.not.null;
  });

  it('Should load services as singletons default', async () => {
    const target = {
      services: [] as any[],
    };

    ResolveFromFiles('/**/*.{ts,js}', 'system.dirs.singletons')(target, 'services');

    const services = await target.services;
    const cache = DI.RootContainer.Cache;

    expect(services).to.be.an('array').that.have.length(2);
    expect(cache.get('FooService')).to.not.null;
    expect(cache.get('FooService2')).to.not.null;

    expect(DI.resolve(FooService)).to.be.not.null;
    expect(FooService.Counter).to.eq(1);

    console.log(services);
  });

  it('Should load service async', async () => {
    const target = {
      services: [] as any[],
    };

    ResolveFromFiles('/**/*.{ts,js}', 'system.dirs.async')(target, 'services');

    expect(target.services).to.be.fulfilled.and.eventually.be.an('array');

    const servs = await target.services;
    expect(servs[0].name).to.eq('FooServiceAsync');
    expect(servs[0].instance.Counter).to.eq(1);
  });

  it('Should load mixed sync and async as async', async () => {
    const target = {
      services: [] as any[],
    };

    ResolveFromFiles('/**/*.{ts,js}', 'system.dirs.mixed')(target, 'services');

    const servs = await target.services;
    expect(servs[0].name).to.eq('FooServiceMixed');
  });

  // it('Should throw when class not found', () => {
  //   const target = {
  //     services: [] as any[],
  //   };

  //   ResolveFromFiles('/**/*.{ts,js}', 'system.dirs.throw')(target, 'services');

  //   expect(() => {
  //     // tslint:disable-next-line: no-unused-expression-chai
  //     target.services;
  //   }).to.throw(ReflectionException);
  // });

  it('Should load service as new always', async () => {
    const target = {
      services: [] as any[],
    };

    const target2 = {
      services: [] as any[],
    };

    ResolveFromFiles('/**/*.{ts,js}', 'system.dirs.alwaysnew')(target, 'services');
    ResolveFromFiles('/**/*.{ts,js}', 'system.dirs.alwaysnew')(target2, 'services');

    const serv1 = await target.services;
    const serv2 = await target2.services;

    expect(serv1[0].instance.Counter).to.eq(1);
    expect(serv2[0].instance.Counter).to.eq(1);

    expect(DI.RootContainer.Cache.get('FooServiceAlwaysNew')).to.be.not.null;
  });
});
