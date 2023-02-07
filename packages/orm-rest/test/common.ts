import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';

import './migrations/Test_2022_06_28_01_13_00.js';

import express from 'express';
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

export function req() {
  return chai.request('http://localhost:1337/');
}

export class TestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      system: {
          dirs: {
            controllers: [dir('./../src/controllers'), dir('./controllers')],
          },
      },
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'ConsoleTarget',
          },
        ],

        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      http: {
        middlewares: [
          express.json({
            limit: '5mb',
          }),
          express.urlencoded({
            extended: true,
          }),
          (req: any, _res: any, next: any) => {
            req.User = {
              Role: 'admin',
            };
            next();
          },
        ],
        AcceptHeaders: 1 | 2,
        cookie: {
          secret: 'dasdasdas',
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
