import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import * as _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
const express = require('express');

chai.use(chaiHttp);
chai.use(chaiAsPromised);

chai.use(require('chai-subset'));
chai.use(require('chai-like'));
chai.use(require('chai-things'));

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export function req() {
  return chai.request('http://localhost:1337/');
}

export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      system: {
        dirs: {
          migrations: [dir('./migrations')],
          models: [dir('./models')],
          controllers: [dir('./../src/controllers'), dir('./controllers')],
        },
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
