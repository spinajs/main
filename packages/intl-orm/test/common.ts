import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import { mergeArrays } from './util';

chai.use(chaiHttp);
chai.use(chaiAsPromised);

chai.use(require('chai-subset'));
chai.use(require('chai-like'));
chai.use(require('chai-things'));

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'ConsoleTarget',
              layout: '${datetime} ${level} ${message} ${error} duration: ${duration} ms (${logger})',
            },
          ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        db: {
          DefaultConnection: 'sqlite',
          Connections: [
            {
              Debug: {
                Queries: true,
              },
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'sqlite',
              Migration: {
                Table: 'orm_migrations',
                OnStartup: true,
              },
            },
          ],
        },
      },
      mergeArrays,
    );
  }
}
