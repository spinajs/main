import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration } from './common.js';

describe('RBAC HTTP', function () {
  this.timeout(85000);

  before(async () => {
    DI.setESMModuleSupport();

    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Controllers);

    const server = await DI.resolve<HttpServer>(HttpServer);
    server.start();
  });

  after(async () => {
    const server = await DI.resolve(HttpServer);
    server.stop();
  });

  afterEach(() => {
    sinon.restore();
  });


  describe('User basic HTTP functionality', () => {
    it('Simple login should work', async () => {});

    it('Logout should work', async () => {});

    it('Session refresh should work', async () => {});  

    it('Password change should work', async () => {});


  });
});
