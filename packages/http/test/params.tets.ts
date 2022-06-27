import 'mocha';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import chai from 'chai';
import chaiHttp from 'chai-http';
import { SpinaJsDefaultLog, LogModule } from '@spinajs/log';
import { Controllers, HttpServer } from '../src';
import { Intl } from '@spinajs/intl';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import { TestConfiguration } from './common';

chai.use(chaiHttp);
chai.use(chaiAsPromised);

describe('controller action test params', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SpinaJsDefaultLog).as(LogModule);

    await DI.resolve(LogModule);
    await DI.resolve(Intl);
    await DI.resolve<Controllers>(Controllers);
    const server = await DI.resolve<HttpServer>(HttpServer);

    server.start();
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('query params', function () {});

  describe('headers params', function () {});

  describe('url params', function () {});

  describe('body params', function () {});

  describe('form params', function () {});

  describe('coockie params', function () {});

  describe('from cvs file', function () {});

  describe('from json files', function () {});

  describe('custom types', function () {});

  describe('date types', function () {});
});
