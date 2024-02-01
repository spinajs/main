import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import chaiLike from 'chai-like';
import chaiThings from 'chai-things';

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);
chai.use(chaiLike);
chai.use(chaiThings);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class TestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'ConsoleTarget',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      rbac: {
        // default roles to manage users & guest account
        roles: [
          {
            Name: 'admin',
            Description: 'Administrator',
          },
          {
            Name: 'user',
            Description: 'Simple account without any privlidge',
          },
          {
            Name: 'guest',
            Description: 'Guest account',
          }
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
