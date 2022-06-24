import { Configuration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import { DI, IContainer } from '@spinajs/di';
import { SpinaJsDefaultLog, LogModule } from '@spinajs/log';
import * as _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Intl, SpineJsInternationalizationFromJson } from '../src';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class ConnectionConf extends Configuration {
  protected conf = {
    system: {
      dirs: {
        locales: [dir('./locales')],
      },
    },
    intl: {
      defaultLocale: 'pl',
    },
  };

  // tslint:disable-next-line: no-empty
  public resolve(_container: IContainer) {}

  public get(path: string[], defaultValue?: any): any {
    return _.get(this.conf, path, defaultValue);
  }
}

describe('Internationalization tests', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SpinaJsDefaultLog).as(LogModule);
    DI.register(SpineJsInternationalizationFromJson).as(Intl);

    DI.resolve(LogModule);
  });

  afterEach(async () => {
    DI.clear();
  });

  it('Should autoregister in DI', () => {
    expect(DI.check(Intl)).to.be.true;
    expect(DI.resolve(Intl).constructor.name).to.eq('SpineJsInternationalizationFromJson');
  });

  it('Should load multiple json files', () => {
    const intl = DI.resolve<Intl>(Intl);

    expect(intl.Locales.has('en'));
    expect(intl.Locales.has('pl'));

    expect(intl.Locales.get('en')).to.eql({
      hello: 'hello',
      'hello %s': 'hello %s',
    });

    expect(intl.Locales.get('pl')).to.eql({
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

  it('should translate simple', () => {
    const intl = DI.resolve<Intl>(Intl);

    expect(intl.__('hello %s', 'bemon')).to.eq('witaj bemon');
  });

  it('should translate with specified locale', () => {
    const intl = DI.resolve<Intl>(Intl);

    expect(intl.__({ phrase: 'hello %s', locale: 'en' }, 'bemon')).to.eq('hello bemon');
  });

  it('should return original if not exists', () => {
    const intl = DI.resolve<Intl>(Intl);

    expect(intl.__('hello from other side')).to.eq('hello from other side');
  });

  it('should translate plural', () => {
    const intl = DI.resolve<Intl>(Intl);

    expect(intl.__n('%d cats', 3)).to.eq('3 koty');
    expect(intl.__n('%d cats', 1)).to.eq('1 kot');
    expect(intl.__n('%d cats', 2)).to.eq('2 koty');
    expect(intl.__n('%d cats', 10)).to.eq('10 kotów');
  });

  it('shoudl get avaible translations', () => {
    const intl = DI.resolve<Intl>(Intl);
    expect(intl.__l('hello')).to.be.an('array').with.length(2);
  });
});
