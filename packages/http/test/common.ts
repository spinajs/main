import { DI } from '@spinajs/di';
import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { Controllers } from '../src';
import { join, normalize, resolve } from 'path';
import * as _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';

chai.use(chaiHttp);
chai.use(chaiAsPromised);

chai.use(require('chai-subset'));
chai.use(require('chai-like'));
chai.use(require('chai-things'));

export function req() {
  return chai.request('http://localhost:8888/');
}

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class TestConfiguration extends FrameworkConfiguration {
  constructor() {
    super({
      cfgCustomPaths: [dir('./config')],
    });
  }

  public async resolveAsync(): Promise<void> {
    await super.resolveAsync();

    _.merge(this.Config, {
      system: {
        dirs: {
          controllers: [dir('./controllers')],
        },
      },
      intl: {
        defaultLocale: 'pl',
      },
    });
  }
}

export function ctr() {
  return DI.get(Controllers);
}