import { DI, Bootstrapper } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { Controllers, HttpServer } from '@spinajs/http';
import { AuthorizedPolicy, RbacPolicy, ACL_CONTROLLER_DESCRIPTOR } from '@spinajs/rbac-http';
import { DbConfig } from '@spinajs/configuration-db-source';
import { expect } from 'chai';
import 'mocha';

import { TestConfiguration, FakePolicy, req, seed } from './common.js';
import { ConfigurationController } from '../src/controllers/Configuration.js';
import configurationHttpConfig from '../src/config/configuration-http.js';

const JSON_HEADERS = { Accept: 'application/json' };

describe('configuration-http api', function () {
  this.timeout(25000);

  before(async () => {
    DI.clearCache();

    const fsBootstrapper = await DI.resolve(FsBootsrapper);
    fsBootstrapper.bootstrap();

    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.setESMModuleSupport();

    // bypass auth so we can exercise controller logic
    DI.register(FakePolicy).as(AuthorizedPolicy);
    DI.register(FakePolicy).as(RbacPolicy);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      // skip the db-source bootstrapper, it installs a watch timer that would
      // keep the event loop alive after the suite finishes
      if (b.constructor.name === 'DbConfigSourceBotstrapper') {
        continue;
      }
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Controllers);

    const server = await DI.resolve(HttpServer);
    server.start();
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();

    const orm = DI.get(Orm);
    orm?.dispose();
    DI.uncache(Orm);
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await DbConfig.truncate();
    await seed();
  });

  describe('GET /configuration', () => {
    it('lists all entries', async () => {
      const res = await req().get('configuration').set(JSON_HEADERS);
      expect(res).to.have.status(200);
      expect(res.body).to.be.an('array').with.lengthOf(7);
      expect(res.body.map((e: any) => e.Slug)).to.include.members(['app.name', 'mail.from', 'app.maxUsers']);
    });

    it('filters by group', async () => {
      const res = await req().get('configuration?group=mail').set(JSON_HEADERS);
      expect(res).to.have.status(200);
      expect(res.body).to.be.an('array').with.lengthOf(1);
      expect(res.body[0].Slug).to.equal('mail.from');
    });
  });

  describe('GET /configuration/:slug', () => {
    it('returns a single entry', async () => {
      const res = await req().get('configuration/app.name').set(JSON_HEADERS);
      expect(res).to.have.status(200);
      expect(res.body.Slug).to.equal('app.name');
      expect(res.body.Value).to.equal('spinajs');
      expect(res.body.Type).to.equal('string');
    });

    it('returns the entry meta as an object', async () => {
      const res = await req().get('configuration/app.maxUsers').set(JSON_HEADERS);
      expect(res).to.have.status(200);
      expect(res.body.Meta).to.deep.equal({ min: 1, max: 100 });
    });

    it('returns 404 for unknown slug', async () => {
      const res = await req().get('configuration/does.not.exist').set(JSON_HEADERS);
      expect(res).to.have.status(404);
    });
  });

  describe('PATCH /configuration/:slug', () => {
    it('updates a string value and persists it', async () => {
      const res = await req().patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'changed' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('changed');

      const get = await req().get('configuration/app.name').set(JSON_HEADERS);
      expect(get.body.Value).to.equal('changed');
    });

    it('coerces and stores an integer value', async () => {
      const res = await req().patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 50 });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('50');
    });

    it('stores a boolean as canonical 1/0', async () => {
      const res = await req().patch('configuration/app.debug').set(JSON_HEADERS).send({ Value: true });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('1');

      const get = await req().get('configuration/app.debug').set(JSON_HEADERS);
      expect(get.body.Value).to.equal('1');
    });

    it('updates a date value in canonical format', async () => {
      const res = await req().patch('configuration/app.startDate').set(JSON_HEADERS).send({ Value: '15-06-2021' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('15-06-2021');
    });

    it('accepts an allowed oneOf value', async () => {
      const res = await req().patch('configuration/app.theme').set(JSON_HEADERS).send({ Value: 'light' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('light');
    });

    it('can toggle the Watch flag', async () => {
      const res = await req().patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'spinajs', Watch: true });
      expect(res).to.have.status(200);
      expect(Boolean(res.body.Watch)).to.equal(true);
    });

    it('rejects an out-of-range integer', async () => {
      const res = await req().patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 999 });
      expect(res).to.have.status(400);
    });

    it('rejects a non-integer value', async () => {
      const res = await req().patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 'abc' });
      expect(res).to.have.status(400);
    });

    it('rejects a value not in oneOf', async () => {
      const res = await req().patch('configuration/app.theme').set(JSON_HEADERS).send({ Value: 'blue' });
      expect(res).to.have.status(400);
    });

    it('returns 404 when updating an unknown slug', async () => {
      const res = await req().patch('configuration/does.not.exist').set(JSON_HEADERS).send({ Value: 'x' });
      expect(res).to.have.status(404);
    });
  });
});

describe('configuration-http rbac wiring', () => {
  it('declares the configuration resource and route permissions', () => {
    const descriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, ConfigurationController.prototype);
    expect(descriptor).to.be.an('object');
    expect(descriptor.Resource).to.equal('configuration');
    expect(descriptor.Routes.get('list').Permission).to.deep.equal(['readAny']);
    expect(descriptor.Routes.get('get').Permission).to.deep.equal(['readAny']);
    expect(descriptor.Routes.get('update').Permission).to.deep.equal(['updateAny']);
  });

  it('ships a configuration role that admin extends', () => {
    const grants = (configurationHttpConfig as any).rbac.grants;
    expect(grants.configuration.configuration).to.have.property('read:any');
    expect(grants.configuration.configuration).to.have.property('update:any');
    expect(grants.admin.$extend).to.include('configuration');
  });
});
