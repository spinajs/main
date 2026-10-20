import type { AddressInfo } from 'node:net';
import { DI } from '@spinajs/di';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { HttpServer } from '@spinajs/http';
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

// http.port is 0, so every start binds a free port and parallel runs never collide; requests read it back from the running server.
export function appPort(): number {
  const address = DI.get(HttpServer)?.Server?.address() as AddressInfo | null | undefined;
  if (!address) throw new Error('no http server listening: start HttpServer first');
  return address.port;
}

export const appOrigin = (): string => `http://localhost:${appPort()}`;

export function req() {
  return chai.request(`${appOrigin()}/`);
}



export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      system: {
        dirs: {
          controllers: [dir('./../src/controllers'), dir('./controllers')],
        },
      },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [

          {
            service: 'fsNative',
            name: 'fs-temp',
            basePath: dir('./files'),
          },
          // The http package resolves these named providers when HttpServer /
          // controller cache boot; this config replaces the framework defaults
          // wholesale, so they must be declared here (mirrors http-swagger's
          // known-good test config).
          {
            service: 'fsNative',
            name: '__fs_controller_cache__',
            basePath: dir('./cache'),
          },
          {
            service: 'fsNative',
            name: '__fs_http_response_templates__',
            basePath: resolve(normalize(join(process.cwd(), '..', 'http', 'src', 'views', 'responses'))),
          },

        ],
      },
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'ConsoleTarget',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      http: {
        port: 0,
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
        // filters.test.ts registers filter_regression, which no migration creates.
        StrictTableCheck: false,
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
