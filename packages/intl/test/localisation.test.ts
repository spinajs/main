import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import { DI } from '@spinajs/di';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Intl, SpineJsInternationalizationFromJson } from '../src';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.merge(this.Config, {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: {
        dirs: {
          locales: [dir('./locales')],
        },
      },
      intl: {
        defaultLocale: 'pl',
      },
    });
  }
}

describe('Internationalization tests', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SpineJsInternationalizationFromJson).as(Intl);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  it('Should autoregister in DI', async () => {
    expect(DI.check(Intl)).to.be.true;

    const intl = await DI.resolve(Intl);
    expect(intl.constructor.name).to.eq('SpineJsInternationalizationFromJson');
  });

  it('Should load multiple json files', async () => {
    const intl = await DI.resolve<Intl>(Intl);

    expect((intl.Locales as any)['en']);
    expect((intl.Locales as any)['pl']);

    expect((intl.Locales as any)['en']).to.eql({
      hello: 'hello',
      'hello %s': 'hello %s',
    });

    expect((intl.Locales as any)['pl']).to.eql({
      hello: 'witaj',
      world: 'świecie',
      'hello %s': 'witaj %s',
      '%d cats': {
        one: '%d kot',
        two: '%d koty',
        few: '%d koty',
        other: '%d kotów',
      },
    });
  });

  it('should translate simple', async () => {
    const intl = await DI.resolve<Intl>(Intl);

    expect(intl.__('hello %s', 'bemon')).to.eq('witaj bemon');
  });

  it('should translate with specified locale', async () => {
    const intl = await DI.resolve<Intl>(Intl);

    expect(intl.__({ phrase: 'hello %s', locale: 'en' }, 'bemon')).to.eq('hello bemon');
  });

  it('should return original if not exists', async () => {
    const intl = await DI.resolve<Intl>(Intl);

    expect(intl.__('hello from other side')).to.eq('hello from other side');
  });

  it('should translate plural', async () => {
    const intl = await DI.resolve<Intl>(Intl);

    expect(intl.__n('%d cats', 3)).to.eq('3 koty');
    expect(intl.__n('%d cats', 1)).to.eq('1 kot');
    expect(intl.__n('%d cats', 2)).to.eq('2 koty');
    expect(intl.__n('%d cats', 10)).to.eq('10 kotów');
  });

  it('shoudl get avaible translations', async () => {
    const intl = await DI.resolve<Intl>(Intl);
    expect(intl.__l('hello')).to.be.an('array').with.length(3);
  });

  it('should load js files', async () => {
    const intl = await DI.resolve<Intl>(Intl);
    expect((intl.Locales as any)['de']);

    expect((intl.Locales as any)['de']).to.eql({
      hello: 'Backpfeifengesicht',
    });
  });
});
