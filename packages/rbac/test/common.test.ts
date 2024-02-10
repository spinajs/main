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
        email: {
          connection: 'rbac-email-connection',
    
          changePassword: {
            enabled: true,
            template: './user-change-password-template.pug',
            subject: 'Password change request',
          },
    
          // when user is created & activated should he receive email
          created: {
            enabled: true,
            template: './user-creation-email-template.pug',
            subject: 'Please confirm your email',
          },
    
          banned: {
            enabled: true,
            template: './user-banned-email-template.pug',
            subject: 'Account banned',
          },
    
          unbanned: {
            enabled: true,
            template: './user-unbanned-email-template.pug',
            subject: 'Account unbanned',
          },
    
          deleted: { 
            enabled: true,
            template: './user-deleted-email-template.pug',
            subject: 'Account deleted',
          },
    
          deactivated: { 
            enabled: true,
            template: './user-deactivated-email-template.pug',
            subject: 'Account deactivated',
          },
    
          // when user is created, should he confirm email
          // if false, user is acvite at creation,
          // when true, first, user will be sent confirmation email
          confirm: {
            enabled: true,
            template: './user-confirmation-email-template.pug',
            subject: 'Account created',
          }
        },
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
