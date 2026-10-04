import { DI } from '@spinajs/di';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { AuthorizationModel } from '@spinajs/authz';
import type { DecisionRequest } from '@spinajs/authz';
import { ACCESS_DESCRIPTOR, accessDescriptorOf } from '@spinajs/authz-http';
import type { IAccessDescriptor } from '@spinajs/authz-http';
import { StaticModel, testHost } from '@spinajs/authz-testing';
import type { ScriptedVote } from '@spinajs/authz-testing';
import { DbConfig } from '@spinajs/configuration-db-source';
import { expect } from 'chai';
import 'mocha';

import { req, seed, testConfig } from './common.js';
import { startApp, stopApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';
import { ConfigurationController } from '../src/controllers/Configuration.js';
import { ConfigurationHttpBootstrapper } from '../src/bootstrap.js';
import configurationHttpConfig from '../src/config/configuration-http.js';

const JSON_HEADERS = { Accept: 'application/json' };

const permitted = { permitWhen: { op: 'true' } } as const;

// what the `masked` principal may read
const MASKED_READ = ['Slug', 'Group', 'Type', 'Label'];

const votes = (r: DecisionRequest): ScriptedVote => {
  switch (r.principal.id) {
    case 'admin':
      return r.permission.startsWith('configuration:') ? permitted : {};
    case 'editor':
      return r.permission === 'configuration:update' && r.resource.id === 'app.name' ? permitted : {};
    case 'masked':
      return r.permission === 'configuration:read' ? { ...permitted, fields: { read: MASKED_READ } } : {};
    default:
      return {};
  }
};

describe('configuration-http api', function () {
  this.timeout(25000);

  let unregisterSource: () => void;
  let unregisterModel: (() => void) | undefined;

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    unregisterSource = registerHeaderSource();

    await startApp({
      controllers: [ConfigurationController],
      config: testConfig(),
      // the db-source one installs a watch timer that would keep the event loop alive; the
      // other registers DbConfig with the ORM guard, which is not merged yet ( needs L4 )
      skip: ['DbConfigSourceBotstrapper', 'ConfigurationHttpBootstrapper'],
    });
    unregisterModel = testHost.registerInRoot(
      AuthorizationModel,
      testHost.instance(new StaticModel({ name: 'config-votes', votes, capabilities: { fields: true } })),
    );
  });

  after(async () => {
    const orm = DI.get(Orm);
    orm?.dispose();
    DI.uncache(Orm);
    unregisterModel?.();
    await stopApp();
    unregisterSource();
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
      expect(res.body).to.be.an('array').with.lengthOf(11);
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

    it('stores a boolean as canonical true/false', async () => {
      const res = await req().patch('configuration/app.debug').set(JSON_HEADERS).send({ Value: true });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('true');

      const get = await req().get('configuration/app.debug').set(JSON_HEADERS);
      expect(get.body.Value).to.equal('true');
    });

    it('updates a date value in canonical ISO format', async () => {
      const res = await req().patch('configuration/app.startDate').set(JSON_HEADERS).send({ Value: '2021-06-15' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('2021-06-15');
    });

    it('accepts an allowed oneOf value', async () => {
      const res = await req().patch('configuration/app.theme').set(JSON_HEADERS).send({ Value: 'light' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('light');
    });

    it('accepts a manyOf subset and stores it canonically', async () => {
      const res = await req()
        .patch('configuration/app.features')
        .set(JSON_HEADERS)
        .send({ Value: ['a', 'c'] });
      expect(res).to.have.status(200);
      expect(JSON.parse(res.body.Value)).to.deep.equal(['a', 'c']);
    });

    it('accepts a float value within bounds', async () => {
      const res = await req().patch('configuration/app.ratio').set(JSON_HEADERS).send({ Value: 0.75 });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('0.75');
    });

    it('accepts a datetime-range and stores it joined by ;', async () => {
      const res = await req()
        .patch('configuration/app.window')
        .set(JSON_HEADERS)
        .send({ Value: ['2021-01-01T00:00:00.000+00:00', '2021-06-01T00:00:00.000+00:00'] });
      expect(res).to.have.status(200);
      expect((res.body.Value as string).split(';')).to.have.lengthOf(2);
    });

    it('validates the Default value too', async () => {
      const res = await req().patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 50, Default: 5 });
      expect(res).to.have.status(200);
      expect(res.body.Default).to.equal('5');
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

    it('rejects a manyOf value outside the allowed set', async () => {
      const res = await req()
        .patch('configuration/app.features')
        .set(JSON_HEADERS)
        .send({ Value: ['a', 'z'] });
      expect(res).to.have.status(400);
    });

    it('rejects a non-array manyOf value', async () => {
      const res = await req().patch('configuration/app.features').set(JSON_HEADERS).send({ Value: 'a' });
      expect(res).to.have.status(400);
    });

    it('rejects an out-of-range float', async () => {
      const res = await req().patch('configuration/app.ratio').set(JSON_HEADERS).send({ Value: 5 });
      expect(res).to.have.status(400);
    });

    it('rejects an invalid Default value', async () => {
      const res = await req().patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 50, Default: 999 });
      expect(res).to.have.status(400);
    });

    it('returns 404 when updating an unknown slug', async () => {
      const res = await req().patch('configuration/does.not.exist').set(JSON_HEADERS).send({ Value: 'x' });
      expect(res).to.have.status(404);
    });
  });

  describe('PATCH /configuration/:slug with a schema registered under the slug', () => {
    it('accepts a string value that satisfies the registered schema', async () => {
      const res = await req().patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'short' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('short');
    });

    it('rejects a string value violating the registered schema and keeps the stored value', async () => {
      const res = await req().patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'ab' });
      expect(res).to.have.status(400);
      expect(res.body.error.message).to.contain('Value');

      const get = await req().get('configuration/app.name').set(JSON_HEADERS);
      expect(get.body.Value).to.equal('spinajs');
    });

    it('accepts a json object matching the registered schema', async () => {
      const res = await req()
        .patch('configuration/app.limits')
        .set(JSON_HEADERS)
        .send({ Value: { perPage: 50, export: true } });
      expect(res).to.have.status(200);
      expect(JSON.parse(res.body.Value)).to.deep.equal({ perPage: 50, export: true });
    });

    it('rejects a json object with an out of range property', async () => {
      const res = await req()
        .patch('configuration/app.limits')
        .set(JSON_HEADERS)
        .send({ Value: { perPage: 0 } });
      expect(res).to.have.status(400);
      expect(res.body.error.message).to.contain('Value/perPage');
    });

    it('rejects a json object missing a required property', async () => {
      const res = await req()
        .patch('configuration/app.limits')
        .set(JSON_HEADERS)
        .send({ Value: { export: true } });
      expect(res).to.have.status(400);
    });

    it('rejects a json object with an unknown property', async () => {
      const res = await req()
        .patch('configuration/app.limits')
        .set(JSON_HEADERS)
        .send({ Value: { perPage: 10, other: 1 } });
      expect(res).to.have.status(400);
    });

    it('validates the Default value against the registered schema too', async () => {
      const res = await req()
        .patch('configuration/app.limits')
        .set(JSON_HEADERS)
        .send({ Value: { perPage: 10 }, Default: { perPage: 1000 } });
      expect(res).to.have.status(400);
      expect(res.body.error.message).to.contain('Default');
    });

    it('keeps type-only validation for entries without a registered schema', async () => {
      const res = await req().patch('configuration/mail.from').set(JSON_HEADERS).send({ Value: 'x' });
      expect(res).to.have.status(200);
    });

    it('responds 500 naming the slug when the registered schema cannot be compiled, and keeps the stored value', async () => {
      const res = await req().patch('configuration/app.broken').set(JSON_HEADERS).send({ Value: 'y' });
      expect(res).to.have.status(500);
      expect(res.body.error.message).to.contain('app.broken');

      const get = await req().get('configuration/app.broken').set(JSON_HEADERS);
      expect(get.body.Value).to.equal('x');
    });
  });

  describe('access control', () => {
    const ROUTES: [string, (user: string | null) => PromiseLike<ChaiHttp.Response>][] = [
      ['GET /configuration', (u) => req(u).get('configuration').set(JSON_HEADERS)],
      ['GET /configuration/:slug', (u) => req(u).get('configuration/app.name').set(JSON_HEADERS)],
      [
        'PATCH /configuration/:slug',
        (u) => req(u).patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'nope' }),
      ],
    ];

    for (const [name, call] of ROUTES) {
      it(`${name} answers 403 to a principal without the permission`, async () => {
        expect(await call('alice')).to.have.status(403);
      });

      it(`${name} answers 401 without a principal`, async () => {
        expect(await call(null)).to.have.status(401);
      });
    }

    it('keeps the stored value after a refused update', async () => {
      await req('alice').patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'nope' });
      await req(null).patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'nope' });

      const res = await req().get('configuration/app.name').set(JSON_HEADERS);
      expect(res.body.Value).to.equal('spinajs');
    });

    it('lets a grant restricted to one slug update that slug', async () => {
      const res = await req('editor').patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'renamed' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('renamed');
    });

    it('answers 403 for another slug under that grant and keeps its value', async () => {
      const res = await req('editor').patch('configuration/mail.from').set(JSON_HEADERS).send({ Value: 'x@y.z' });
      expect(res).to.have.status(403);

      const get = await req().get('configuration/mail.from').set(JSON_HEADERS);
      expect(get.body.Value).to.equal('noreply@spinajs.com');
    });

    it('drops the fields a grant does not read, from a list and from one entry', async () => {
      const list = await req('masked').get('configuration').set(JSON_HEADERS);
      expect(list).to.have.status(200);
      expect(list.body).to.have.lengthOf(11);
      for (const entry of list.body) {
        expect(entry).to.not.have.any.keys('Value', 'Default', 'Meta');
        expect(entry.Slug).to.be.a('string');
      }

      const one = await req('masked').get('configuration/app.name').set(JSON_HEADERS);
      expect(one).to.have.status(200);
      expect(one.body).to.deep.equal({ Slug: 'app.name', Group: 'app', Type: 'string', Label: 'App name' });
    });
  });
});

describe('configuration-http access wiring', () => {
  const rule = (method: string) => accessDescriptorOf(ConfigurationController)!.Access.get(method)!;

  it('declares the permission and the slug resource of every route', () => {
    const descriptor = Reflect.getMetadata(ACCESS_DESCRIPTOR, ConfigurationController.prototype) as IAccessDescriptor;
    expect(descriptor).to.be.an('object');
    expect(rule('list').permissions).to.deep.equal(['configuration:read']);
    expect(rule('get').permissions).to.deep.equal(['configuration:read']);
    expect(rule('update').permissions).to.deep.equal(['configuration:update']);
    expect(rule('list').options.resource).to.equal(undefined);
    expect(rule('get').options.resource).to.be.a('function');
    expect(rule('update').options.resource).to.be.a('function');
  });

  it('filters the fields of every route', () => {
    for (const method of ['list', 'get', 'update']) expect(rule(method).options.fields).to.equal('filter');
  });

  it('declares both permissions with field sets', () => {
    expect(configurationHttpConfig.authz.permissions).to.deep.equal({
      'configuration:read': { fields: true },
      'configuration:update': { fields: true },
    });
  });

  it('grants configuration management only through an admin sub-role', () => {
    const { roles } = configurationHttpConfig.authz.rbac;

    expect(roles['admin.configuration'].assignable).to.equal(false);
    expect(roles['admin.configuration'].grants).to.have.members(['configuration:read', 'configuration:update']);
    expect(roles.admin.extends).to.include('admin.configuration');

    // no other role defined by this module mentions the permissions: it is admin-only
    const mentioning = Object.entries(roles)
      .filter(([, def]) => JSON.stringify(def).includes('configuration:'))
      .map(([name]) => name);
    expect(mentioning).to.deep.equal(['admin.configuration']);
  });

  it('writes no legacy rbac key', () => {
    expect(configurationHttpConfig).to.not.have.property('rbac');
  });

  // registerAccessResource is a throwing stub until L4 merges and offers no lookup to assert on,
  // so this only pins that bootstrapping succeeds once it is real
  it.skip('registers DbConfig as the configuration access resource (needs L4)', () => {
    expect(() => new ConfigurationHttpBootstrapper().bootstrap()).to.not.throw();
  });
});
