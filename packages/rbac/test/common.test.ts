import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';

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

    this.Config = {
      rbac: {
        // default roles to manage users & guest account
        roles: [
          {
            Name: 'Admin',
            Description: 'Administrator',
          },
          {
            Name: 'User',
            Description: 'Simple account without any privlidge',
          },
        ],
        defaultRole: 'guest',
        session: {
          // 2h session expiration  time
          expiration: 120,
        },
        password: {
          provider: 'BasicPasswordProvider',
          minPasswordLength: 6,
        },
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
    };
  }
}
