import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import * as _ from 'lodash';
import chaiAsPromised from 'chai-as-promised';
chai.use(chaiAsPromised);

chai.use(require('chai-subset'));
chai.use(require('chai-like'));
chai.use(require('chai-things'));

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class TestConfiguration extends FrameworkConfiguration {
  public async resolveAsync(): Promise<void> {
    await super.resolveAsync();

    this.Config = {
      system: {
        dirs: {
          migrations: [dir('./../src/migrations')],
          models: [dir('./../src/models')],
        },
      },
      db: {
        DefaultConnection: 'orm-event-transport',

        Connections: [
          {
            Debug: {
              Queries: true,
            },
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'orm-event-transport',
            Migration: {
              Table: 'orm_migrations',
              OnStartup: true,
            },
          },
        ],
      },
    };
  }
}
